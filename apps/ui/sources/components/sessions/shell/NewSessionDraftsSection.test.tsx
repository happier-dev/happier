import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createThemeFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { FocusReturnProvider, useFocusReturnFallbackRef } from '@/keyboard/focusReturn';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { NewSessionDraftProjection as RepositoryNewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { SessionDraftDocumentV1} from '@happier-dev/protocol/drafts/sessionDrafts';
import type { NewSessionDraftDocumentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { resolveSessionListRowTitleTextMetrics } from '@/components/sessions/shell/resolveSessionListDensityViewState';

type NewSessionDraftProjection = RepositoryNewSessionDraftProjection & {
    document: (SessionDraftDocumentV1 | NewSessionDraftDocumentV2) & { target: { kind: 'newSession' } };
};

function readableDraft<T extends Omit<NewSessionDraftProjection, 'readView'>>(input: T): T & Pick<NewSessionDraftProjection, 'readView'> {
    return { ...input, readView: {
        address: { kind: 'newSession', draftId: input.draftId },
        revision: 0, materialized: true, status: input.status, conflict: input.conflict,
        createdAt: input.createdAt, updatedAt: input.updatedAt, localSupplement: input.localSupplement,
        composer: input.document.composer, documentVersion: input.document.v, targetKind: 'newSession',
    } };
}

type CataloguedNewSessionDraftDocument = Extract<
    NewSessionDraftProjection['document'],
    { v: 2 }
>;

function assertCataloguedNewSessionDocument(
    document: NewSessionDraftProjection['document'],
): asserts document is CataloguedNewSessionDraftDocument {
    if (document.v !== 2 || document.target.kind !== 'newSession') {
        throw new Error('expected a catalogued new-session draft');
    }
}
import type { RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import {
    resolveNewSessionDraftAgentId,
    resolveNewSessionDraftMachineId,
} from '@/components/sessions/drafts/newSessionDraftPresentation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_A_SCOPE = { serverId: 'home-a', accountId: 'account-a' } as const;
const HOME_B_SCOPE = { serverId: 'home-b', accountId: 'account-b' } as const;

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({ Pressable: 'Pressable' });
    const MockView = React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref) => {
        React.useImperativeHandle(ref, () => ({
            isConnected: true,
            focus: () => focusState.calls.push(String(props.testID)),
        }), [props.testID]);
        return React.createElement('View', props, props.children);
    });
    return { ...base, View: MockView };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => (
            key === 'sessionDrafts.sectionTitleForHome' || key === 'sessionDrafts.waitingSectionTitleForHome'
                ? `${key}:${String(params?.home ?? '')}`
                : key
        ),
    });
});
// Catalog consumers read the locale through this entry point as well. Keep
// locale I/O at the same testkit boundary as `t`, rather than loading all locales.
vi.mock('@/text/i18n', async (importOriginal) => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return { ...(await importOriginal<typeof import('@/text/i18n')>()), ...createTextModuleMock() };
});
const focusState = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/components/ui/lists/Item', async () => {
    const ReactModule = await import('react');
    return {
        Item: (props: any) => {
            ReactModule.useEffect(() => {
                const assign = (value: unknown) => {
                    if (typeof props.pressableRef === 'function') props.pressableRef(value);
                    else if (props.pressableRef) props.pressableRef.current = value;
                };
                assign({ focus: () => focusState.calls.push(props.testID) });
                return () => assign(null);
            }, [props.pressableRef, props.testID]);
            return ReactModule.createElement('Item', props, props.rightElement);
        },
    };
});
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: any) => React.createElement('Icon', props),
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));
vi.mock('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon', () => ({
    SessionAgentCatalogIdentityIcon: (props: any) => React.createElement('SessionAgentCatalogIdentityIcon', props),
}));
// The catalog is internal logic and the testkit's own fixtures read it, so this
// keeps the real module and overrides only the presentation leaves in play.
vi.mock('@/agents/catalog/catalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/agents/catalog/catalog')>()),
    getAgentPickerIconScale: () => 1,
}));

await loadSyncSingletonForTests();
const draftPresentation = await import('@/components/sessions/drafts/newSessionDraftPresentation');
const {
    NewSessionDraftsSectionView, buildNewSessionDraftContinueRoute, buildNewSessionDraftRowPresentation,
    isNewSessionDraftDeletionBlocked,
    resolveNewSessionDraftSectionTitle, resolveNewSessionDraftWaitingSectionTitle, resolveNewSessionDraftMachineUnavailable,
} = await import('./NewSessionDraftsSection');

function draft(
    overrides: Partial<NewSessionDraftProjection> = {},
    prompt = 'Fix login\nwith tests',
): NewSessionDraftProjection {
    return readableDraft({
        draftId: '00000000-0000-4000-8000-000000000001',
        document: {
            v: 1,
            composer: {
                text: { mutationId: 'm-text', value: prompt },
                mentions: { mutationId: 'm-mentions', value: [] },
                attachments: { mutationId: 'm-attachments', value: [] },
            },
            target: {
                kind: 'newSession',
                authoring: {
                    directory: { mutationId: 'm-dir', value: '/Users/alice/private-project' },
                    serverId: { mutationId: 'm-server', value: 'server-a' },
                    machineId: { mutationId: 'm-machine', value: 'machine-a' },
                    agentId: { mutationId: 'm-agent', value: 'codex' },
                },
            },
            extensions: {},
        },
        status: 'pending',
        conflict: null,
        createdAt: 10,
        updatedAt: 20,
        localSupplement: {},
        ...overrides,
    });
}

/**
 * Temporary-computer authoring is catalogued only in the current document, so
 * every Runner draft fixture is a V2 document rather than the released V1
 * vocabulary the ordinary `draft()` fixture keeps.
 */
function temporaryComputerDraft(input: Readonly<{
    base?: NewSessionDraftProjection;
    serverId: string;
    activationRef?: Readonly<{ v: 1; activationId: string; createdOnDeviceLabel: string }>;
}>): NewSessionDraftProjection {
    const base = input.base ?? draft();
    return readableDraft({
        ...base,
        document: {
            v: 2,
            composer: base.document.composer,
            target: {
                kind: 'newSession',
                authoring: {
                    directory: { mutationId: 'm-dir', value: '/Users/alice/private-project' },
                    executionTarget: {
                        mutationId: 'm-target',
                        value: {
                            kind: 'temporary_computer',
                            serverId: input.serverId,
                            artifactTarget: 'linux-x64',
                            workspace: { kind: 'choose_on_endpoint' },
                        },
                    },
                    ...(input.activationRef
                        ? { temporaryComputerActivationRef: { mutationId: 'm-activation', value: input.activationRef } }
                        : {}),
                },
            },
            extensions: {},
        },
    });
}

describe('NewSessionDraftsSection', () => {
    afterEach(() => {
        focusState.calls = [];
        standardCleanup();
    });

    it('renders only the edited draft while typing and keeps unchanged availability inert', async () => {
        // Observe the real row's presentation work, without replacing its implementation.
        const presentation = vi.spyOn(draftPresentation, 'buildNewSessionDraftRowPresentation');
        const first = draft({ draftId: 'draft-first' });
        const second = draft({ draftId: 'draft-second' });
        const onContinue = vi.fn();
        const onDelete = vi.fn(async () => false);
        const render = (edited: NewSessionDraftProjection, machineUnavailable = false) => (
            <NewSessionDraftsSectionView
                drafts={[edited, second]}
                availabilityByDraftId={{
                    [first.draftId]: { machineUnavailable: false, pluginUnavailable: false, attachmentNeedsAttention: false },
                    [second.draftId]: { machineUnavailable, pluginUnavailable: false, attachmentNeedsAttention: false },
                }}
                onContinue={onContinue}
                onDelete={onDelete}
            />
        );
        try {
            const screen = await renderScreen(render(first));
            presentation.mockClear();
            let edited = first;
            for (let index = 1; index <= 14; index++) {
                edited = draft({ draftId: first.draftId }, 'x'.repeat(index));
                await act(async () => screen.update(render(edited)));
            }
            const editedRenders = presentation.mock.calls.filter(([value]) => value.draftId === first.draftId).length;
            const untouchedRenders = presentation.mock.calls.filter(([value]) => value.draftId === second.draftId).length;
            expect({ editedRenders, untouchedRenders }).toEqual({ editedRenders: 14, untouchedRenders: 0 });
            expect(screen.findByTestId(`session-draft-row:new-session:${first.draftId}`)?.props.title).toBe('x'.repeat(14));
            // A fresh projection of the same availability does not invalidate either row.
            presentation.mockClear();
            await act(async () => screen.update(render(edited)));
            expect(presentation).not.toHaveBeenCalled();
            // Real availability changes still reach exactly the affected row.
            await act(async () => screen.update(render(edited, true)));
            expect(presentation.mock.calls.map(([value]) => value.draftId)).toEqual([second.draftId]);
            expect(screen.findByTestId(`session-draft-row:new-session:${second.draftId}`)?.props.subtitle)
                .toBe('sessionDrafts.availability.machineUnavailable');
            await screen.unmount();
        } finally {
            presentation.mockRestore();
        }
    });

    it('shows a few drafts with the full count, and every draft once asked', async () => {
        const drafts = Array.from({ length: 7 }, (_, index) => draft({ draftId: `draft-${index}` }, `Draft ${index}`));
        const screen = await renderScreen(
            <NewSessionDraftsSectionView drafts={drafts} onContinue={vi.fn()} onDelete={vi.fn(async () => false)} />,
        );
        const shownRows = () => drafts.filter((entry) => screen.findByTestId(`session-draft-row:new-session:${entry.draftId}`)).length;

        // The group keeps its true count while listing only the newest few.
        expect(screen.findByTestId('session-drafts-header-count')).toBeTruthy();
        expect(shownRows()).toBe(3);
        const showAll = screen.findByTestId('session-drafts-show-all');
        expect(showAll?.props.title).toBe('sessionDrafts.showAll');

        await act(async () => showAll?.props.onPress());
        expect(shownRows()).toBe(7);
        expect(screen.findByTestId('session-drafts-show-all')).toBeNull();
        await screen.unmount();
    });

    it('lists a short drafts group whole, with nothing to expand', async () => {
        const drafts = [draft({ draftId: 'draft-a' }), draft({ draftId: 'draft-b' })];
        const screen = await renderScreen(
            <NewSessionDraftsSectionView drafts={drafts} onContinue={vi.fn()} onDelete={vi.fn(async () => false)} />,
        );
        expect(screen.findByTestId('session-draft-row:new-session:draft-b')).toBeTruthy();
        expect(screen.findByTestId('session-drafts-show-all')).toBeNull();
        await screen.unmount();
    });

    it('uses the latest committed deletion handler without rendering unchanged rows', async () => {
        const presentation = vi.spyOn(draftPresentation, 'buildNewSessionDraftRowPresentation');
        const drafts = [draft()];
        const onContinue = vi.fn();
        const oldDelete = vi.fn(async () => false);
        const currentDelete = vi.fn(async () => false);
        const render = (onDelete: typeof oldDelete) => (
            <NewSessionDraftsSectionView drafts={drafts} onContinue={onContinue} onDelete={onDelete} rowScope={HOME_A_SCOPE} />
        );
        try {
            const screen = await renderScreen(render(oldDelete));
            presentation.mockClear();
            await screen.update(render(currentDelete));
            expect(presentation).not.toHaveBeenCalled();
            await act(async () => {
                screen.findByTestId(`session-draft-delete:new-session:${drafts[0].draftId}`)?.props.onPress({ stopPropagation() {} });
            });
            expect(oldDelete).not.toHaveBeenCalled();
            expect(currentDelete).toHaveBeenCalledWith(drafts[0].draftId, HOME_A_SCOPE);
            await screen.unmount();
        } finally {
            presentation.mockRestore();
        }
    });

    it('derives a prompt-first title without routine machine, folder, agent, or model metadata', () => {
        const presentation = buildNewSessionDraftRowPresentation(draft());
        expect(presentation).toEqual({ title: 'Fix login', statusKey: 'sessionDrafts.status.syncing' });
        expect(JSON.stringify(presentation)).not.toContain('machine-a');
        expect(JSON.stringify(presentation)).not.toContain('private-project');
        expect(JSON.stringify(presentation)).not.toContain('codex');
        expect(JSON.stringify(presentation)).not.toContain('/Users/alice');
    });

    it('labels the draft owner Home instead of implying Team-filtered draft ownership', () => {
        expect(resolveNewSessionDraftSectionTitle({
            serverId: 'home-a',
            homeName: 'Alice’s Home',
            viewContext: { kind: 'team', team: { serverId: 'home-b', teamId: 'team-b' }, teamDisplayName: 'Design' },
        })).toBe('sessionDrafts.sectionTitleForHome:Alice’s Home');
        expect(resolveNewSessionDraftSectionTitle({
            serverId: 'home-a',
            homeName: 'Alice’s Home',
            viewContext: { kind: 'team', team: { serverId: 'home-a', teamId: 'team-a' }, teamDisplayName: 'Design' },
        })).toBe('sessionDrafts.sectionTitle');
        expect(resolveNewSessionDraftSectionTitle({
            serverId: 'home-a',
            homeName: null,
            viewContext: { kind: 'global' },
        })).toBe('sessionDrafts.sectionTitle');
        expect(resolveNewSessionDraftSectionTitle({
            serverId: null,
            homeName: null,
            viewContext: { kind: 'global' },
        })).toBe('sessionDrafts.sectionTitle');
    });

    it('binds Continue to the exact draft Home and Account scope', () => {
        expect(buildNewSessionDraftContinueRoute('draft-b', HOME_B_SCOPE)).toEqual({
            pathname: '/new',
            params: {
                draftId: 'draft-b',
                spawnServerId: 'home-b',
                draftServerId: 'home-b',
                draftAccountId: 'account-b',
            },
        });
    });

    it('names the Home that owns a cross-Home waiting request', () => {
        expect(resolveNewSessionDraftWaitingSectionTitle({ serverId: 'home-b', homeName: 'Bob’s Home' }))
            .toBe('sessionDrafts.waitingSectionTitleForHome:Bob’s Home');
        expect(resolveNewSessionDraftWaitingSectionTitle({ serverId: 'home-b', homeName: '  ' }))
            .toBe('sessionDrafts.waitingSectionTitleForHome:home-b');
    });

    it('projects canonical Runner activation status without creating a draft-local lifecycle', async () => {
        const projection = draft();
        const runnerDraft: NewSessionDraftProjection = {
            ...temporaryComputerDraft({
                base: projection,
                serverId: 'home-a',
                activationRef: {
                    v: 1,
                    activationId: '00000000-0000-4000-8000-000000000099',
                    createdOnDeviceLabel: 'Alice’s Mac',
                },
            }),
            status: 'clean',
        };
        const read = vi.fn(async () => ({
            activationId: '00000000-0000-4000-8000-000000000099',
            state: 'claimed',
            review: {
                sealedLaunchManifest: 'sealed',
                authoringCommitment: 'A'.repeat(43),
                launchManifestCommitment: 'a'.repeat(64),
                credentialSelectionBinding: { v: 1, resourceId: 'resource-1', brokerMachineId: 'broker-1', revision: 1,
                    application: { agentTargetKey: 'agent:happier.agent.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
                    sourceRevision: 'source-1' },
            },
            materialization: null,
        }) as never);
        const cancel = vi.fn();
        const client = { read, cancel } as unknown as RunnerActivationClient;
        const onDelete = vi.fn(async () => true);
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[runnerDraft]}
                runnerActivationClient={client}
                onContinue={vi.fn()}
                onDelete={onDelete}
            />,
        );

        await vi.waitFor(() => expect(
            screen.findByTestId(`session-draft-row:new-session:${runnerDraft.draftId}`)?.props.subtitle,
        ).toBe('newSession.temporaryComputer.status.waiting_for_approval'));
        expect(read).toHaveBeenCalledWith(
            '00000000-0000-4000-8000-000000000099',
            expect.any(AbortSignal),
        );
        await act(async () => screen.findByTestId(
            `session-draft-delete:new-session:${runnerDraft.draftId}`,
        )?.props.onPress({ stopPropagation: vi.fn() }));
        await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith(runnerDraft.draftId));
        expect(cancel).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('uses the first nonblank prompt line instead of treating leading whitespace as an empty prompt', () => {
        const withLeadingBlankLine = draft({}, '\n  Keep the second line  \nthird');
        expect(buildNewSessionDraftRowPresentation(withLeadingBlankLine).title).toBe('Keep the second line');
    });

    it('projects installed Agent identities from the canonical authoring target', () => {
        const projection = temporaryComputerDraft({ serverId: 'server-a' });
        const document = projection.document;
        assertCataloguedNewSessionDocument(document);
        const installedProjection = readableDraft({
            ...projection,
            document: {
                v: 2,
                composer: document.composer,
                extensions: {},
                target: {
                    kind: 'newSession',
                    authoring: {
                        directory: document.target.authoring.directory,
                        agentTarget: {
                            mutationId: 'm-agent',
                            value: {
                                kind: 'agent',
                                identity: { pluginId: 'acme.agent.review', localId: 'review' },
                            },
                        },
                    },
                },
            },
        });

        expect(resolveNewSessionDraftAgentId(installedProjection)).toBe('acme.agent.review/review');
    });

    it('does not infer a user-facing interrupted state from local launch-attempt metadata', () => {
        const projection = draft({
            status: 'clean',
            localSupplement: { launchUserAttemptId: 'attempt-a' },
        });

        expect(buildNewSessionDraftRowPresentation(projection).statusKey).toBeNull();
    });

    it('presents exactly one prioritized safe problem label supplied by current owners', () => {
        const presentation = buildNewSessionDraftRowPresentation(draft(), {
            machineUnavailable: true,
            pluginUnavailable: true,
            attachmentNeedsAttention: true,
        });
        expect(presentation.statusKey).toBe('sessionDrafts.availability.machineUnavailable');
        expect(JSON.stringify(presentation)).not.toContain('sessionDrafts.availability.pluginUnavailable');
        expect(JSON.stringify(presentation)).not.toContain('sessionDrafts.availability.attachmentNeedsAttention');
        expect(JSON.stringify(presentation)).not.toContain('/private/daemon/socket');
    });

    it('resolves the selected Machine from the released and the catalogued draft document alike', () => {
        const released = draft();
        expect(resolveNewSessionDraftMachineId(released)).toBe('machine-a');

        const catalogued = readableDraft({
            ...released,
            document: {
                v: 2,
                composer: released.document.composer,
                target: {
                    kind: 'newSession',
                    authoring: {
                        executionTarget: {
                            mutationId: 'm-target',
                            value: { kind: 'machine', target: { serverId: 'home-a', machineId: 'machine-b' } },
                        },
                    },
                },
                extensions: {},
            },
        });
        expect(resolveNewSessionDraftMachineId(catalogued)).toBe('machine-b');

        // A Temporary computer names no Machine, so it must never be reported
        // as a selected Machine that is offline.
        expect(resolveNewSessionDraftMachineId(temporaryComputerDraft({ serverId: 'home-a' }))).toBeNull();
    });

    it('marks a selected visible-but-offline machine unavailable only from a current inventory', () => {
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: 'machine-a',
            inventoryCurrent: true,
            onlineMachineIds: new Set(),
        })).toBe(true);
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: '  machine-a  ',
            inventoryCurrent: true,
            onlineMachineIds: new Set(['machine-a']),
        })).toBe(false);
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: 'machine-a',
            inventoryCurrent: false,
            onlineMachineIds: new Set(),
        })).toBe(false);
    });


    it('allows a Runner waiting draft to use the canonical canceling tombstone while preserving ordinary launch custody', () => {
        const ordinary = draft();
        const launchUserAttemptId = 'attempt-1';
        const operation = {
            snapshot: {
                requestId: launchUserAttemptId,
                scope: { accountId: 'account-a' },
                actionId: 'session.spawn_new',
                state: 'running',
            },
        } as never;
        const withAttempt = { ...ordinary, localSupplement: { launchUserAttemptId } };
        expect(isNewSessionDraftDeletionBlocked({
            draft: withAttempt,
            accountId: 'account-a',
            operations: [operation],
        })).toBe(true);

        const runner = {
            ...temporaryComputerDraft({ base: ordinary, serverId: 'home-a' }),
            localSupplement: { launchUserAttemptId },
        } satisfies NewSessionDraftProjection;
        expect(isNewSessionDraftDeletionBlocked({
            draft: runner,
            accountId: 'account-a',
            operations: [operation],
        })).toBe(false);
    });

    it('renders saved drafts with a direct delete action outside row activation', async () => {
        const projection = draft();
        const onContinue = vi.fn();
        const onDelete = vi.fn(async () => true);
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={onContinue}
                onDelete={onDelete}
            />,
        );
        const row = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        row?.props.onPress();
        const deleteButton = screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`);
        const stopPropagation = vi.fn();
        await act(async () => deleteButton?.props.onPress({ stopPropagation }));
        expect(onContinue).toHaveBeenCalledWith(projection.draftId);
        expect(onDelete).toHaveBeenCalledWith(projection.draftId);
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-draft-new')).toBeNull();
        expect(row?.props).toMatchObject({
            subtitle: 'sessionDrafts.status.syncing',
            subtitleTestID: `session-draft-status:new-session:${projection.draftId}`,
            rightElementOutsidePressable: true,
        });
        expect(String(row?.props.accessibilityLabel)).not.toContain('sessionDrafts.badge');
        expect(Object.assign({}, ...([] as any[]).concat(deleteButton?.props.style ?? []))).toMatchObject({
            width: 24,
            height: 24,
        });
        expect(deleteButton?.props.accessibilityLabel).toBe('sessionDrafts.delete.action');
        expect(screen.findByTestId(`session-draft-menu:new-session:${projection.draftId}`)).toBeNull();
        await screen.unmount();
    });

    it('labels the drafts group like a project group, with a quiet count instead of a grouped sheet title', async () => {
        const first = draft();
        const second = draft({ draftId: '00000000-0000-4000-8000-000000000002' }, 'Second');
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[first, second]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const header = screen.findByTestId('session-drafts-header');
        expect(header).toBeTruthy();
        expect(screen.getTextContent()).toContain('sessionDrafts.sectionTitle');
        expect(screen.findByTestId('session-drafts-header-count')?.props.children).toBe(2);
        // The grouped sheet title is the uppercase eyebrow the rail no longer uses.
        expect(screen.findByType('ItemGroup' as any)?.props.title).toBeUndefined();
        await screen.unmount();
    });

    it('keeps the inline delete quiet at rest and tints it only while hovered or pressed', async () => {
        const theme = createThemeFixture();
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const deleteId = `session-draft-delete:new-session:${projection.draftId}`;
        const glyphColor = () => screen.findByTestId(deleteId)?.findByType('Icon' as any).props.color;
        expect(screen.findByTestId(deleteId)?.props.accessibilityLabel).toBe('sessionDrafts.delete.action');
        expect(glyphColor()).toBe(theme.colors.text.secondary);
        await act(async () => screen.findByTestId(deleteId)?.props.onHoverIn?.());
        expect(glyphColor()).toBe(theme.colors.state.danger.foreground);
        await act(async () => screen.findByTestId(deleteId)?.props.onHoverOut?.());
        expect(glyphColor()).toBe(theme.colors.text.secondary);
        await act(async () => screen.findByTestId(deleteId)?.props.onPressIn?.());
        expect(glyphColor()).toBe(theme.colors.state.danger.foreground);
        await screen.unmount();
    });

    it('shows the web delete only while its row is hovered or the button has keyboard focus', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const slotId = `session-draft-action-slot:new-session:${projection.draftId}`;
        const deleteId = `session-draft-delete:new-session:${projection.draftId}`;
        const slotOpacity = () => Object.assign({}, ...([] as any[]).concat(screen.findByTestId(slotId)?.props.style ?? [])).opacity;
        expect(slotOpacity()).toBe(0);
        // Hidden visually only: it stays in the tab order and keeps its accessible name.
        expect(screen.findByTestId(deleteId)?.props.disabled).toBeFalsy();
        await act(async () => screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.onHoverIn?.());
        expect(slotOpacity()).toBe(1);
        await act(async () => screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.onHoverOut?.());
        expect(slotOpacity()).toBe(0);
        await act(async () => screen.findByTestId(deleteId)?.props.onFocus?.());
        expect(slotOpacity()).toBe(1);
        await screen.unmount();
    });

    it('binds Continue and Delete to the row\'s exact Home and Account scope', async () => {
        const projection = draft();
        const scope = { serverId: 'home-b', accountId: 'account-b' } as const;
        const onContinue = vi.fn();
        const onDelete = vi.fn(async () => true);
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                rowScope={scope}
                serverId={scope.serverId}
                onContinue={onContinue}
                onDelete={onDelete}
            />,
        );

        screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.onPress();
        await act(async () => screen.findByTestId(
            `session-draft-delete:new-session:${projection.draftId}`,
        )?.props.onPress({ stopPropagation: vi.fn() }));

        expect(onContinue).toHaveBeenCalledWith(projection.draftId, scope);
        expect(onDelete).toHaveBeenCalledWith(projection.draftId, scope);
        await screen.unmount();
    });

    it('matches Session-list density while preserving an edge-aligned direct action target', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const row = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        expect(row?.props).toMatchObject({
            density: 'tight',
            titleLines: 1,
            subtitle: undefined,
            rightElementOutsidePressable: true,
            style: { height: 34, minHeight: 34, paddingVertical: 0 },
            titleStyle: { fontSize: 12, lineHeight: 16 },
        });
        expect(row?.props.leftElement?.props).toMatchObject({
            agentId: 'codex',
            machineId: 'machine-a',
            serverId: null,
            size: 14,
            testID: `session-draft-agent-logo:new-session:${projection.draftId}`,
        });
        expect(String(row?.props.accessibilityLabel)).toContain('sessionDrafts.status.syncing');
        expect(Object.assign({}, ...([] as any[]).concat(
            screen.findByTestId(`session-draft-action-slot:new-session:${projection.draftId}`)?.props.style ?? [],
        ))).toMatchObject({
            alignItems: 'flex-end',
            width: 24,
        });
        expect(Object.assign({}, ...([] as any[]).concat(
            screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)?.props.style ?? [],
        ))).toMatchObject({
            width: 24,
            height: 24,
        });
        await screen.unmount();

        const detailed = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="default"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        expect(detailed.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props).toMatchObject({
            density: 'comfortable',
            titleLines: 2,
            subtitle: 'sessionDrafts.status.syncing',
            style: { height: 84, minHeight: 84, paddingVertical: 0 },
            titleStyle: resolveSessionListRowTitleTextMetrics({ density: 'default', readableNativePhoneMinimal: false }),
            subtitleStyle: { fontSize: 12, lineHeight: 16 },
        });
        expect(detailed.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.leftElement).toBeUndefined();
        await detailed.unmount();
    });

    it('renders an external draft through its exact machine-qualified Agent identity', async () => {
        const projection = draft();
        const document = projection.document;
        if (document.v !== 1 || document.target.kind !== 'newSession') {
            throw new Error('expected a released new-session draft');
        }
        const externalProjection = readableDraft({
            ...projection,
            document: {
                ...document,
                target: {
                    ...document.target,
                    authoring: {
                        ...document.target.authoring,
                        agentId: { mutationId: 'm-agent-external', value: 'plugin:acme.review' },
                    },
                },
            },
        });
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[externalProjection]}
                serverId="server-a"
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );

        expect(screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.leftElement?.props)
            .toMatchObject({
                agentId: 'plugin:acme.review',
                machineId: 'machine-a',
                serverId: 'server-a',
            });
    });

    it('reads the Agent badge identity from the catalogued V2 authoring target', () => {
        const projection = temporaryComputerDraft({ serverId: 'server-a' });
        const document = projection.document;
        assertCataloguedNewSessionDocument(document);
        const v2Projection = readableDraft({
            ...projection,
            document: {
                ...document,
                target: {
                    ...document.target,
                    authoring: {
                        ...document.target.authoring,
                        agentTarget: {
                            mutationId: 'm-agent-target',
                            value: {
                                kind: 'agent',
                                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                            },
                        },
                    },
                },
            },
        });

        expect(resolveNewSessionDraftAgentId(v2Projection)).toBe('codex');

        const installedProjection = readableDraft({
            ...v2Projection,
            document: {
                ...v2Projection.document,
                target: {
                    ...v2Projection.document.target,
                    authoring: {
                        ...v2Projection.document.target.authoring,
                        agentTarget: {
                            mutationId: 'm-installed-agent-target',
                            value: {
                                kind: 'agent',
                                identity: { pluginId: 'acme.review', localId: 'reviewer' },
                            },
                        },
                    },
                },
            },
        });
        expect(resolveNewSessionDraftAgentId(installedProjection)).toBe('acme.review/reviewer');
    });

    it('keeps an installed Agent’s draft on its own identity instead of the default mark', async () => {
        const document = draft().document;
        if (document.v !== 1) throw new Error('expected a released new-session draft');
        const projection = draft({
            document: {
                ...document,
                target: {
                    kind: 'newSession',
                    authoring: {
                        directory: { mutationId: 'm-dir', value: '/Users/alice/private-project' },
                        machineId: { mutationId: 'm-machine', value: 'machine-a' },
                        agentId: { mutationId: 'm-agent', value: 'acme.plugin/ultracode' },
                    },
                },
            },
        });
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );

        const row = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        expect(row?.props.leftElement?.props.agentId).not.toBe('claude');
    });

    it('renders nothing when the repository has no saved new-session drafts', async () => {
        const screen = await renderScreen(
            <NewSessionDraftsSectionView drafts={[]} onContinue={vi.fn()} onDelete={vi.fn(async () => false)} />,
        );
        expect(screen.findByTestId('session-drafts-section')).toBeNull();
        await screen.unmount();
    });

    it('disables deletion while launch custody is retained', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
                deleteDisabledDraftIds={new Set([projection.draftId])}
            />,
        );
        expect(screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)?.props).toMatchObject({
            disabled: true,
            accessibilityState: { disabled: true },
        });
        await screen.unmount();
    });

    it('restores focus to the nearest surviving row, then the canonical list fallback', async () => {
        const first = draft();
        const second = { ...draft(), draftId: '00000000-0000-4000-8000-000000000002', updatedAt: 19 };

        function Harness() {
            const [drafts, setDrafts] = React.useState<readonly NewSessionDraftProjection[]>([first, second]);
            const fallbackRef = useFocusReturnFallbackRef<React.ElementRef<typeof View> | null>();
            return (
                <View ref={fallbackRef} testID="session-list-focus-fallback">
                    <NewSessionDraftsSectionView
                        drafts={drafts}
                        onContinue={vi.fn()}
                        onDelete={async (draftId) => {
                            setDrafts((current) => current.filter((candidate) => candidate.draftId !== draftId));
                            return true;
                        }}
                    />
                </View>
            );
        }

        const screen = await renderScreen(<FocusReturnProvider><Harness /></FocusReturnProvider>);
        await act(async () => screen.findByTestId(`session-draft-delete:new-session:${first.draftId}`)?.props.onPress({
            stopPropagation: vi.fn(),
        }));
        await vi.waitFor(() => expect(focusState.calls).toContain(
            `session-draft-row:new-session:${second.draftId}`,
        ));

        await act(async () => screen.findByTestId(`session-draft-delete:new-session:${second.draftId}`)?.props.onPress({
            stopPropagation: vi.fn(),
        }));
        await vi.waitFor(() => expect(focusState.calls).toContain('session-list-focus-fallback'));
        await screen.unmount();
    });
});
