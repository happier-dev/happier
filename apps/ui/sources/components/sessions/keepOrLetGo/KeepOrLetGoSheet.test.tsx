import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, createSessionFixture, renderScreen } from '@/dev/testkit';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resetLeavingSessionsResourceForTests } from '@/sync/domains/session/retention/leavingSessionsResource';
import { loadLocalSettings } from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';

import { KeepOrLetGoSheet } from './KeepOrLetGoSheet';

// Secure credential storage is a platform boundary; the pin owner and its scope resolution run for real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: async () => ({ token: 'token-a', secret: 'secret-a' }),
        },
    };
});

const DAY_MS = 86_400_000;
const NOW = Date.now();
const RULE = { retentionDays: 60, noticeDays: 7, floorAt: NOW - DAY_MS };

type Request = Readonly<{ method: string; url: string }>;

function sessionIds(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `leaving-${String(index).padStart(2, '0')}`);
}

function seedSessions(ids: readonly string[]) {
    const activity = NOW - (RULE.retentionDays - 3) * DAY_MS;
    storage.getState().applySessions(ids.map((id) => createSessionFixture({
        id,
        updatedAt: activity,
        activeAt: activity,
        metadata: {
            ...createSessionFixture().metadata!,
            summary: { text: `What ${id} last said`, updatedAt: activity },
        },
    })));
    return {
        rule: RULE,
        count: ids.length,
        newestLeavesAt: activity + RULE.retentionDays * DAY_MS,
        sessions: ids.map((id) => ({ id, updatedAt: activity, activeAt: activity })),
        nextCursor: null,
    };
}

const flush = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('KeepOrLetGoSheet', () => {
    let requests: Request[];
    let leavingPayload: unknown;
    let plansEnabled: boolean;
    let pinResponse: () => Response;

    beforeEach(() => {
        resetLeavingSessionsResourceForTests();
        resetServerFeaturesClientForTests();
        upsertAndActivateServer({ serverUrl: 'http://keep.example.test' });
        storage.getState().applyLocalSettings({ leavingFootDismissals: {} });
        storage.getState().clearSessionOrganizationForServer(getActiveServerSnapshot().serverId);
        requests = [];
        plansEnabled = false;
        pinResponse = () => new Response(JSON.stringify({ pin: { sessionId: 'x', sortKey: null, pinnedAt: 1 } }), { status: 200 });
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/health')) return new Response('{}', { status: 200 });
            const method = String(init?.method ?? 'GET').toUpperCase();
            requests.push({ method, url });
            if (url.includes('/v1/features')) {
                return new Response(JSON.stringify(createRootLayoutFeaturesResponse({
                    features: { plans: { enabled: plansEnabled } },
                })), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('/v2/sessions/leaving')) return new Response(JSON.stringify(leavingPayload), { status: 200 });
            if (url.includes('/v2/session-organization/pins/')) return pinResponse();
            return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        });
    });

    afterEach(() => {
        resetRuntimeFetch();
        resetLeavingSessionsResourceForTests();
    });

    const leavingReads = () => requests.filter((request) => request.url.includes('/v2/sessions/leaving')).length;
    const serverWrites = () => requests.filter((request) => request.method !== 'GET' && request.method !== 'HEAD');

    it('walks a developer preview batch from its own cards, reading and writing nothing on the server', async () => {
        const onClose = vi.fn();
        const preview = {
            retentionDays: 60,
            sessions: [
                { id: 'preview-a', title: 'Fix the relay reconnect', subtitle: 'studio-mac · Last active Sep 2', leavesAt: NOW + 3 * DAY_MS },
                { id: 'preview-b', title: 'Draft the 0.2 release notes', subtitle: null, leavesAt: NOW + 5 * DAY_MS },
            ],
        };
        const screen = await renderScreen(<KeepOrLetGoSheet onClose={onClose} preview={preview} />);
        await flush();

        expect(screen.getTextContent()).toContain('Fix the relay reconnect');
        await act(async () => {
            screen.pressByTestId('keep-stack-keep');
        });
        await flush();
        await act(async () => {
            screen.pressByTestId('keep-stack-let-go');
        });
        await flush();
        expect(screen.findAll((node) => node.props.testID === 'keep-or-let-go-all-set').length).toBeGreaterThan(0);
        expect(requests.filter((request) => !request.url.includes('/v1/features'))).toEqual([]);
        expect(storage.getState().localSettings.leavingFootDismissals).toEqual({});
    });

    it('opens 40 leaving sessions with one list read and builds only the top two previews', async () => {
        const ids = sessionIds(40);
        leavingPayload = seedSessions(ids);
        const screen = await renderScreen(<KeepOrLetGoSheet onClose={vi.fn()} />);
        await flush();

        expect(leavingReads()).toBe(1);
        expect(screen.getTextContent()).toContain('40 sessions are leaving Happier Cloud');
        const previews = new Set(screen.findAll((node) => (
            typeof node.props.testID === 'string' && node.props.testID.startsWith('keep-or-let-go-preview-')
        )).map((node) => node.props.testID));
        expect([...previews].sort()).toEqual([`keep-or-let-go-preview-${ids[0]}`, `keep-or-let-go-preview-${ids[1]}`]);
        const cards = new Set(screen.findAll((node) => (
            typeof node.props.testID === 'string' && node.props.testID.startsWith('keep-stack-card-')
        )).map((node) => node.props.testID));
        expect(cards.size).toBe(3);
    });

    it('lets go with no server write, keeps with one pin, and sums up without a machine claim', async () => {
        const ids = sessionIds(2);
        leavingPayload = seedSessions(ids);
        const onClose = vi.fn();
        const screen = await renderScreen(<KeepOrLetGoSheet onClose={onClose} />);
        await flush();

        await act(async () => {
            screen.pressByTestId('keep-stack-let-go');
        });
        await flush();
        expect(serverWrites()).toEqual([]);
        expect(storage.getState().sessions[ids[0]!]).toBeDefined();

        await act(async () => {
            screen.pressByTestId('keep-stack-keep');
        });
        await flush();
        expect(serverWrites().map((request) => request.method)).toEqual(['PUT']);
        expect(serverWrites()[0]!.url).toContain(`/pins/${ids[1]}`);

        const summary = screen.getTextContent();
        expect(summary).toContain('All set.');
        expect(summary).toContain('1 kept with a pin');
        expect(summary).toContain('1 leaves the cloud on');
        expect(summary).toContain('stays in your list under Direct.');
        expect(summary).not.toMatch(/machine/i);

        await act(async () => {
            screen.pressByTestId('keep-or-let-go-done-primary');
        });
        expect(loadLocalSettings().leavingFootDismissals[getActiveServerSnapshot().serverId]?.leavingThrough)
            .toBe((leavingPayload as { newestLeavesAt: number }).newestLeavesAt);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(serverWrites()).toHaveLength(1);
    });

    it('returns the card with the limit when the pin is refused, offering Plus only where plans show', async () => {
        const ids = sessionIds(3);
        leavingPayload = seedSessions(ids);
        pinResponse = () => new Response(JSON.stringify({ error: 'session-pin-limit-exceeded', limit: 50 }), { status: 409 });

        for (const plans of [false, true]) {
            plansEnabled = plans;
            resetServerFeaturesClientForTests();
            resetLeavingSessionsResourceForTests();
            const screen = await renderScreen(<KeepOrLetGoSheet onClose={vi.fn()} />);
            await flush();
            await act(async () => {
                screen.pressByTestId('keep-stack-keep');
            });
            await flush();

            expect(screen.findByTestId(`keep-stack-card-${ids[0]}`)).not.toBeNull();
            expect(screen.findByTestId('keep-stack-refusal')).not.toBeNull();
            expect(screen.getTextContent()).toContain('50');
            expect(screen.findByTestId('keep-stack-refusal-action') !== null).toBe(plans);
            expect(storage.getState().sessionOrganizationPinsBySessionKey[
                `${getActiveServerSnapshot().serverId}:${ids[0]}`
            ]).toBeUndefined();
            await screen.unmount();
        }
    });

    it('names an inactive leaving session the list holds only as a row, without fetching it', async () => {
        const ids = sessionIds(1);
        leavingPayload = seedSessions(ids);
        // An inactive session from the list page: the store keeps its row projection, not the full session.
        const full = storage.getState().sessions[ids[0]!]!;
        storage.getState().mergeSessionListRenderables([buildSessionListRenderableFromSession(full)]);
        storage.setState((state) => {
            const sessions = { ...state.sessions };
            delete sessions[ids[0]!];
            return { sessions };
        });

        const screen = await renderScreen(<KeepOrLetGoSheet onClose={vi.fn()} />);
        await flush();

        expect(screen.getTextContent()).toContain(`What ${ids[0]} last said`);
        expect(screen.getTextContent()).not.toMatch(/\bunknown\b/i);
    });
});
