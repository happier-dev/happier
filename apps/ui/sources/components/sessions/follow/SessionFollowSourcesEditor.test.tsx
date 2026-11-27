import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { storage } from '@/sync/domains/state/storageStore';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { standardCleanup } from '@/dev/testkit';

import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { OpenedSessionFollowRuleV1Schema } from '@happier-dev/protocol/sessions/follow/actions';
import { SetSessionFollowRuleRequestV1Schema, SESSION_FOLLOW_RULES_ROUTE_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import type { SessionFollowReadInputs } from '@/sync/api/session/sessionFollowRulesApi';

const api = vi.hoisted(() => ({
    list: vi.fn(),
    remove: vi.fn(),
    set: vi.fn(),
}));
const preparation = vi.hoisted(() => ({ run: vi.fn() }));
// The Follow Action transport is the boundary for rule writes and live counts.
const followAction = vi.hoisted(() => ({ execute: vi.fn() }));
const picker = vi.hoisted(() => ({ open: vi.fn() }));
const connectivity = vi.hoisted(() => ({ online: true }));
const useServerScopedMachine = vi.hoisted(() => vi.fn());
const followState = vi.hoisted(() => ({
    rows: {} as Record<string, unknown>,
    machinesByServer: {} as Record<string, readonly Machine[]>,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
// The anchored panel's portal and window measurement are the platform boundary; the panel's own parts stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('@/sync/api/session/sessionFollowSourcesApi', () => ({
    listSessionFollowSources: api.list,
    removeSessionFollowSource: api.remove,
    setSessionFollowSource: api.set,
}));
vi.mock('@/sync/api/session/sessionFollowApi', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    executeSessionFollowAction: followAction.execute,
}));
vi.mock('./prepareSessionFollowSourceKey', () => ({ prepareSessionFollowSourceKey: preparation.run }));
vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isServerReachabilityNetworkAllowed: () => connectivity.online,
    subscribeServerReachabilityNetworkAllowed: () => () => undefined,
}));
vi.mock('./openSessionFollowDestinationPicker', () => ({ openSessionFollowSourcePicker: picker.open }));
vi.mock('@/text', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    t: (key: string, params?: { title?: string }) => params?.title ? `${key}:${params.title}` : key,
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSessionListRowsByServerId: (_serverIds: readonly string[], selector?: (rows: typeof followState.rows) => unknown) => (
            selector ? selector(followState.rows) : followState.rows
        ),
        useServerScopedMachine,
    });
});

import { followSourceKey, SessionFollowSourcesEditor } from './SessionFollowSourcesEditor';
/** The editor as a page section (two grouped sections); the pane form is tested on its own. */
function renderPage(element: React.ReactElement, options?: Parameters<typeof renderSettingsView>[1]) {
    return renderSettingsView(element, {
        ...options,
        wrapper: ({ children }) => <ListPresentationProvider value="page">{children}</ListPresentationProvider>,
    });
}
let accountFixture: Awaited<ReturnType<typeof activateStorageAccountScope>> | undefined;
let ruleHomes: ReturnType<typeof createHomeGovernanceHarness> | undefined;
afterEach(async () => {
    setScreenSharingPrivacyActive(false);
    standardCleanup(); accountFixture?.dispose(); accountFixture = undefined;
    await ruleHomes?.reset(); ruleHomes = undefined;
});

const RULE_HOME = 'srv_follow_editor';

/** Private rule reads and writes share real Home credentials, admission and content codecs. */
async function activateRuleCensus(input: unknown) {
    const rule = OpenedSessionFollowRuleV1Schema.parse(input);
    const { definition, ...identity } = rule;
    let stored = { ...identity, content: sealSessionFollowRuleContentV1({ ...identity, definition, mode: 'plain', material: null }) };
    const writes: Array<ReturnType<typeof SetSessionFollowRuleRequestV1Schema.parse>> = [];
    const homes = createHomeGovernanceHarness();
    ruleHomes = homes;
    installHomeGovernanceBoundaries(homes);
    await homes.addHome({ name: 'Rule editor', serverUrl: 'https://follow-editor.test', serverIdentityId: RULE_HOME,
        accountId: 'follow-account', currentAccount: true, active: false });
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { following: { enabled: true } } } });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId: RULE_HOME, snapshot: { status: 'ready', features } });
    for (const path of ['/v1/features', '/v1/features/authenticated']) homes.answer(RULE_HOME, path, { body: features });
    homes.answer(RULE_HOME, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    homes.answer(RULE_HOME, SESSION_FOLLOW_RULES_ROUTE_V1, { select: () => ({ body: { rules: [stored] } }) });
    api.list.mockImplementation(async (_destination: unknown, _signal: unknown, _accountId: unknown, readInputs: SessionFollowReadInputs) => (
        readInputs.rules.status === 'ready'
            ? { kind: 'ok', value: { sources: [], rules: readInputs.rules.rules, coverage: 'complete' } }
            : { kind: 'failed', error: 'unavailable' }
    ));
    homes.answer(RULE_HOME, `PUT ${SESSION_FOLLOW_RULES_ROUTE_V1}/${rule.ruleId}`, { select: raw => {
        const write = SetSessionFollowRuleRequestV1Schema.parse(raw);
        writes.push(write);
        stored = { ...stored, content: write.content, version: write.expectedVersion + 1 };
        return { body: { rule: stored } };
    } });
    accountFixture?.dispose();
    accountFixture = await activateStorageAccountScope({ serverId: RULE_HOME, accountId: 'follow-account' });
    // The lifecycle helper's default endpoint has no credentials; scoped Follow
    // transport must capture the same actual Home that serves the private census.
    const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    runtime.publishAppliedActiveServerSnapshot({ ...runtime.getAppliedActiveServerSnapshot(), serverUrl: 'https://follow-editor.test' });
    return writes;
}

/** A Home switch changes the real Account lifetime, not only the editor's target props. */
async function switchFixtureHome(serverId: string) {
    await act(async () => {
        accountFixture?.dispose();
        accountFixture = await activateStorageAccountScope({ serverId, accountId: 'follow-account' });
    });
}

/** The shared editor's preset segment (the pressable radio) of a source's policy editor. */
function sourcePresetSegment(screen: Awaited<ReturnType<typeof renderSettingsView>>, sourceSessionId: string, preset: string) {
    return screen.tree.root.findAll((node) => node.props.testID === `session-follow-source-${sourceSessionId}-policy.preset.${preset}`
        && typeof node.props.onPress === 'function')[0];
}

function findSourceRow(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    sourceSessionId: string,
) {
    const testID = `session-follow-source-${sourceSessionId}`;
    return screen.listRows(testID).find((node) => (
        node.props.testID === testID && typeof node.props.subtitle === 'string'
    )) ?? null;
}

/** Opens a source's Follow panel the way a person does: pressing its row. */
async function openSource(screen: Awaited<ReturnType<typeof renderSettingsView>>, sourceSessionId: string) {
    await vi.waitFor(() => expect(findSourceRow(screen, sourceSessionId)).not.toBeNull());
    await act(async () => { findSourceRow(screen, sourceSessionId)?.props.onPress?.(); await Promise.resolve(); });
}

/**
 * The web Pressable host carries `disabled` only while it is disabled, so the
 * component-level boolean is read from the outermost element with the testID.
 */
function readControlDisabled(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    testID: string,
): boolean | undefined {
    return screen.findAllByTestId(testID)[0]?.props.disabled;
}

describe('SessionFollowSourcesEditor', () => {
    beforeEach(async () => {
        accountFixture = await activateStorageAccountScope({ serverId: 'home-a', accountId: 'follow-account' });
        api.list.mockReset();
        api.remove.mockReset();
        api.set.mockReset();
        followAction.execute.mockReset();
        followAction.execute.mockResolvedValue({ kind: 'failed', error: 'unavailable' });
        preparation.run.mockReset();
        picker.open.mockReset();
        preparation.run.mockResolvedValue({ kind: 'waiting', reason: 'runner_unreachable' });
        connectivity.online = true;
        followState.rows = {};
        followState.machinesByServer = {};
        useServerScopedMachine.mockImplementation((serverId: string | null | undefined, machineId: string) => (
            (followState.machinesByServer[serverId ?? ''] ?? []).find((machine) => machine.id === machineId) ?? null
        ));
    });

    it('retries preparation for a retained committed edge after the picker lifetime', async () => {
        const listed = createDeferred<Readonly<{
            kind: 'ok';
            value: {
                sources: Array<{
                    sourceSessionId: string;
                    destinationSessionId: string;
                    policy: { preset: 'quiet' };
                    deliveryState: 'eligible';
                    hasPendingUpdates: boolean;
                }>;
            };
        }>>();
        connectivity.online = true;
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        // Mount/passive-effect scheduling may legitimately coalesce or repeat
        // the same authoritative read. Keep the boundary response stable for
        // the lifetime of this pending observation.
        api.list.mockReturnValue(listed.promise);
        preparation.run.mockResolvedValueOnce({ kind: 'waiting', reason: 'runner_unreachable' });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);

        // Resolve the canonical committed-edge read inside React's update boundary.
        // This keeps the test independent of passive-effect scheduling while still
        // proving that a retained edge (rather than the picker callback) initiates
        // source-key preparation.
        await act(async () => {
            listed.resolve({ kind: 'ok', value: { sources: [{
                sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const }, deliveryState: 'eligible', hasPendingUpdates: false,
            }] } });
            await listed.promise;
        });
        expect(useServerScopedMachine).toHaveBeenCalledWith('home-a', 'runner-a');
        expect(useServerScopedMachine.mock.results.at(-1)?.value?.id).toBe('runner-a');
        await vi.waitFor(() => {
            expect(preparation.run).toHaveBeenCalledWith({
                serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
                signal: expect.anything(),
            });
            expect(findSourceRow(screen, 'source-a')?.props.subtitle)
                .toBe('session.follow.sources.waitingRuntime');
        });
        expect(screen.getTextContent()).toContain('common.retry');
        await act(async () => { screen.findByTestId('session-follow-source-source-a-retry')?.props.onPress?.(); await Promise.resolve(); });
        expect(preparation.run).toHaveBeenCalledTimes(2);

        api.remove.mockResolvedValueOnce({ kind: 'ok', value: { changed: true } });
        api.list.mockResolvedValueOnce({ kind: 'ok', value: { sources: [] } });
        await openSource(screen, 'source-a');
        const removeButton = screen.findByTestId('session-follow-source-source-a-remove');
        await act(async () => { removeButton?.props.onPress?.(); await Promise.resolve(); });
        expect(api.remove).toHaveBeenCalledWith({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        });
        await screen.unmount();
    });

    it('prepares a source again when a removed committed edge is later re-added', async () => {
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const }, deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        let currentSources = [relation];
        api.list.mockImplementation(async () => ({ kind: 'ok', value: { sources: currentSources } }));
        preparation.run.mockResolvedValue({ kind: 'prepared' });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(1));
        await screen.update(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        expect(preparation.run).toHaveBeenCalledTimes(1);

        api.remove.mockResolvedValueOnce({ kind: 'ok', value: { changed: true } });
        currentSources = [];
        await openSource(screen, 'source-a');
        await act(async () => {
            screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).toBeNull());

        currentSources = [relation];
        await act(async () => {
            screen.findByTestId('session-follow-source-add')?.props.onPress?.();
            const onClose = picker.open.mock.calls.at(-1)?.[2];
            expect(onClose).toBeTypeOf('function');
            await onClose(undefined);
        });
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(2));
        await screen.unmount();
    });

    it('retains preparation across a same-Machine reconnect but prepares again for a replacement Machine', async () => {
        const activeAt = Date.now();
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const },
            deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [relation] } });
        preparation.run.mockResolvedValue({ kind: 'prepared' });
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt,
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        const destination = createSessionFixture({ id: 'destination-a' });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => {
            expect(preparation.run).toHaveBeenCalledTimes(1);
            expect(findSourceRow(screen, 'source-a')?.props.subtitle)
                .toBe('session.follow.policy.quiet');
        });

        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-a',
            kind: 'ephemeral_session_runner',
            active: false,
            activeAt: activeAt + 1,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        await screen.update(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await act(async () => { await Promise.resolve(); });
        expect(preparation.run).toHaveBeenCalledTimes(1);

        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-a',
            kind: 'ephemeral_session_runner',
            active: true,
            activeAt: activeAt + 2,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        await screen.update(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await act(async () => { await Promise.resolve(); });
        expect(preparation.run).toHaveBeenCalledTimes(1);

        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-b',
            kind: 'ephemeral_session_runner',
            active: true,
            activeAt: activeAt + 3,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        await screen.update(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-b"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(2));
        expect(preparation.run).toHaveBeenLastCalledWith({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
            signal: expect.anything(),
        });
        await screen.unmount();
    });

    it('ignores a delayed preparation result from the previous destination Machine', async () => {
        const activeAt = Date.now();
        const firstMachinePreparation = createDeferred<Readonly<{ kind: 'prepared' }>>();
        const replacementMachinePreparation = createDeferred<Readonly<{
            kind: 'waiting';
            reason: 'source_key_unavailable';
        }>>();
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' },
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        preparation.run
            .mockReturnValueOnce(firstMachinePreparation.promise)
            .mockReturnValueOnce(replacementMachinePreparation.promise);
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt,
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        const destination = createSessionFixture({ id: 'destination-a' });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(1));

        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-b',
            kind: 'ephemeral_session_runner',
            active: true,
            activeAt: activeAt + 1,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        await screen.update(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-b"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(2));

        await act(async () => {
            firstMachinePreparation.resolve({ kind: 'prepared' });
            await firstMachinePreparation.promise;
        });
        expect(findSourceRow(screen, 'source-a')?.props.subtitle)
            .toBe('session.follow.sources.sourceKeyPreparing');

        await act(async () => {
            replacementMachinePreparation.resolve({ kind: 'waiting', reason: 'source_key_unavailable' });
            await replacementMachinePreparation.promise;
        });
        // An unavailable source key is a settled answer, not the transient "waiting" copy.
        expect(findSourceRow(screen, 'source-a')?.props.subtitle)
            .toBe('session.follow.sources.sourceSessionKeyUnavailable');
        await screen.unmount();
    });

    it('reloads only its exact Home/destination when a committed Session invalidation or reconnect wake arrives', async () => {
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const },
            deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        let currentSources = [relation];
        api.list.mockImplementation(async () => ({ kind: 'ok', value: { sources: currentSources } }));
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId={null}
        />);
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).not.toBeNull());
        const callsAfterMount = api.list.mock.calls.length;

        await act(async () => {
            publishHomeAccountChange('home-b', ['destination-a'], { changeKinds: ['session'] });
            publishHomeAccountChange('home-a', ['unrelated-session'], { changeKinds: ['session'] });
        });
        expect(api.list).toHaveBeenCalledTimes(callsAfterMount);

        currentSources = [];
        await act(async () => {
            publishHomeAccountChange('home-a', ['destination-a']);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).toBeNull());

        currentSources = [relation];
        await act(async () => {
            // Reconnect/cursor-reset wakes have no exact entity page and must
            // conservatively reload this mounted exact-Home projection.
            publishHomeAccountChange('home-a');
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).not.toBeNull());
        await screen.unmount();
    });

    it('lands a read that a Home wake overlaps, so a busy Home cannot keep the list loading', async () => {
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const },
            deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        const reads: Array<ReturnType<typeof createDeferred<Readonly<{ kind: 'ok'; value: { sources: Array<typeof relation> } }>>>> = [];
        api.list.mockImplementation(() => {
            const read = createDeferred<Readonly<{ kind: 'ok'; value: { sources: Array<typeof relation> } }>>();
            reads.push(read);
            return read.promise;
        });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a" destinationMachineId={null}
        />);
        await vi.waitFor(() => expect(reads.length).toBeGreaterThan(0));
        expect(screen.getTextContent()).toContain('common.loading');

        // Wakes arrive faster than the Home answers; each one used to discard the read before it.
        await act(async () => { publishHomeAccountChange('home-a'); await Promise.resolve(); });
        await act(async () => { publishHomeAccountChange('home-a'); await Promise.resolve(); });
        await act(async () => {
            reads[0]!.resolve({ kind: 'ok', value: { sources: [relation] } });
            await reads[0]!.promise;
        });

        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain('common.loading');
        await screen.unmount();
    });

    it('draws one flat pane section with its count and a plus, and two grouped sections inside a page', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'important' },
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        const editor = <SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a" destinationMachineId={null}
        />;
        const pane = await renderSettingsView(editor);
        await vi.waitFor(() => expect(findSourceRow(pane, 'source-a')).not.toBeNull());
        expect(pane.findByTestId('session-follow-sources-pane')).not.toBeNull();
        expect(pane.getTextContent()).not.toContain('common.add');
        // The pane's "+" is the one add control, and it opens the source picker.
        await act(async () => { pane.findByTestId('session-follow-source-add')?.props.onPress?.(); });
        expect(picker.open).toHaveBeenCalledTimes(1);
        await pane.unmount();

        const page = await renderPage(<ListPresentationProvider value="page">{editor}</ListPresentationProvider>);
        await vi.waitFor(() => expect(findSourceRow(page, 'source-a')).not.toBeNull());
        expect(page.findByTestId('session-follow-sources-pane')).toBeNull();
        expect(page.getTextContent()).toContain('common.add');
        await page.unmount();
    });

    it('says what belongs under an empty Following instead of a lone placeholder', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [] } });
        const pane = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a" destinationMachineId={null}
        />);
        await vi.waitFor(() => expect(pane.findByTestId('session-follow-sources-empty')).not.toBeNull());
        expect(pane.getTextContent()).toContain('session.follow.sources.empty');
        expect(pane.getTextContent()).not.toContain('common.none');
        await pane.unmount();
    });

    it('keeps Stop updates available during preparation and rejects the old result after the edge is re-created', async () => {
        const firstPreparation = createDeferred<Readonly<{ kind: 'prepared' }>>();
        const relation = {
            sourceSessionId: 'source-a',
            destinationSessionId: 'destination-a',
            policy: { preset: 'quiet' as const },
            deliveryState: 'eligible' as const,
            hasPendingUpdates: false,
        };
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        let currentSources = [relation];
        api.list.mockImplementation(async () => ({ kind: 'ok', value: { sources: currentSources } }));
        api.remove.mockImplementation(async () => {
            currentSources = [];
            return { kind: 'ok', value: { changed: true } };
        });
        preparation.run
            .mockReturnValueOnce(firstPreparation.promise)
            .mockResolvedValueOnce({ kind: 'waiting', reason: 'source_key_unavailable' });

        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(1));

        await openSource(screen, 'source-a');
        const stop = screen.findByTestId('session-follow-source-source-a-remove');
        expect(stop?.props.disabled).toBe(false);
        await act(async () => {
            stop?.props.onPress?.();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).toBeNull());

        currentSources = [relation];
        await act(async () => {
            screen.findByTestId('session-follow-source-add')?.props.onPress?.();
            const onClose = picker.open.mock.calls.at(-1)?.[2];
            expect(onClose).toBeTypeOf('function');
            await onClose(undefined);
        });
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(2));

        await act(async () => {
            firstPreparation.resolve({ kind: 'prepared' });
            await firstPreparation.promise;
        });
        expect(findSourceRow(screen, 'source-a')?.props.subtitle)
            .toBe('session.follow.sources.sourceSessionKeyUnavailable');
        await screen.unmount();
    });

    it('offers shared policy presets and persists explicit policy independently of destination wake capability', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a',
            destinationSessionId: 'destination-a',
            policy: { preset: 'quiet' },
            deliveryState: 'eligible',
            hasPendingUpdates: false,
        }] } });
        api.set.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
                },
            })],
        };
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).not.toBeNull());
        await act(async () => {
            findSourceRow(screen, 'source-a')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(api.set).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-follow-source-source-a-panel')).not.toBeNull();
        const originalTitle = findSourceRow(screen, 'source-a')?.props.title;
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'home-a': ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic('home-a', 'source-a', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        expect(findSourceRow(screen, 'source-a')?.props.title).toContain('message.sessionReferenceUnavailable');
        expect(screen.findByTestId('session-follow-source-source-a-panel')).not.toBeNull();
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(findSourceRow(screen, 'source-a')?.props.title).toBe(originalTitle);

        expect(sourcePresetSegment(screen, 'source-a', 'quiet')?.props.checked).toBe(true);
        expect(sourcePresetSegment(screen, 'source-a', 'everything')?.props.checked).toBe(false);
        await act(async () => {
            sourcePresetSegment(screen, 'source-a', 'everything')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(api.set).toHaveBeenCalledWith({
            serverId: 'home-a',
            destinationSessionId: 'destination-a',
            sourceSessionId: 'source-a',
            policy: { preset: 'everything', voice: false },
        });
        await screen.unmount();

        api.set.mockClear();
        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-a',
            active: true,
            activeAt: Date.now(),
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        const contextOnlyRuntime = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        // Authoring policy remains available while an older destination runtime
        // waits to update; capability readiness does not choose the saved policy.
        await vi.waitFor(() => expect(findSourceRow(contextOnlyRuntime, 'source-a')).not.toBeNull());
        const contextOnlyRow = findSourceRow(contextOnlyRuntime, 'source-a');
        expect(contextOnlyRow?.props.detail).toBeUndefined();
        expect(contextOnlyRow?.props.onPress).toBeTypeOf('function');
        expect(contextOnlyRow?.props.accessibilityLabel)
            .toBe(`${contextOnlyRow?.props.title}. session.follow.policy.quiet`);
        await act(async () => { contextOnlyRow?.props.onPress?.(); });
        for (const preset of ['everything', 'important', 'quiet', 'custom']) {
            expect(sourcePresetSegment(contextOnlyRuntime, 'source-a', preset)).toBeDefined();
        }
        expect(api.set).not.toHaveBeenCalled();
        await contextOnlyRuntime.unmount();
    });

    it('preserves the exact Custom draft and committed policy across failed save, passive refresh and retry', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
            policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        api.set.mockResolvedValueOnce({ kind: 'failed', error: 'unavailable' });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a" destinationMachineId={null}
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).not.toBeNull());
        await act(async () => { findSourceRow(screen, 'source-a')?.props.onPress?.(); });
        await act(async () => { sourcePresetSegment(screen, 'source-a', 'custom')?.props.onPress?.(); });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-sources-error')).not.toBeNull());
        const request = api.set.mock.calls[0]?.[0];
        expect(request).toMatchObject({ policy: { preset: 'custom', events: {
            needs_you: { decision: { delivery: 'interrupt' }, approval: { delivery: 'interrupt' }, blocked: { delivery: 'interrupt' } },
            finished: { delivery: 'quiet' }, person_wrote: { delivery: 'quiet' }, message: { delivery: 'off' },
        } } });
        const reads = api.list.mock.calls.length;
        await act(async () => { publishHomeAccountChange('home-a', ['destination-a']); });
        await vi.waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(reads));
        expect(screen.findByTestId('session-follow-sources-error')).not.toBeNull();
        expect(sourcePresetSegment(screen, 'source-a', 'custom')?.props.checked).toBe(true);
        api.set.mockResolvedValueOnce({ kind: 'ok', value: { changed: true } });
        await act(async () => { screen.findByTestId('session-follow-sources-error')?.props.onPress?.(); });
        expect(api.set.mock.calls[1]?.[0]).toEqual(request);
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-sources-error')).toBeNull());
        await screen.unmount();
    });

    it('edits one event of a Custom source policy through the shared editor and writes the whole policy', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
            policy: { preset: 'custom', events: { finished: { delivery: 'quiet' }, person_wrote: { delivery: 'quiet' } } },
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        api.set.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a" destinationMachineId={null}
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).not.toBeNull());
        await act(async () => { findSourceRow(screen, 'source-a')?.props.onPress?.(); });
        const finishedPush = screen.tree.root.findAll((node) => node.props.testID === 'session-follow-source-source-a-policy.event.finished.interrupt'
            && typeof node.props.onPress === 'function')[0];
        expect(finishedPush).toBeDefined();
        await act(async () => { finishedPush?.props.onPress(); });
        expect(api.set).toHaveBeenCalledWith(expect.objectContaining({
            sourceSessionId: 'source-a',
            policy: expect.objectContaining({ preset: 'custom', events: expect.objectContaining({
                finished: expect.objectContaining({ delivery: 'interrupt' }), person_wrote: { delivery: 'quiet' },
            }) }),
        }));
        await screen.unmount();
    });

    it('names each Stop updates control with its source session identity', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [
            { sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false },
            { sourceSessionId: 'source-b', destinationSessionId: 'destination-a', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false },
        ] } });
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', metadata: { name: 'Alpha source', path: '/repo/alpha' }, encryptionMode: 'plain' }),
                'source-b': createSessionListRenderableSessionFixture({ id: 'source-b', metadata: { name: 'Beta source', path: '/repo/beta' }, encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true } },
            })],
        };
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);

        // One panel is open at a time: each row opens its own, and Stop updates names that row's source.
        const labels: Array<unknown> = [];
        for (const id of ['source-a', 'source-b']) {
            await openSource(screen, id);
            labels.push(screen.findByTestId(`session-follow-source-${id}-remove`)?.props.accessibilityLabel);
        }
        expect(labels).toEqual([
            'session.follow.sources.stopForSource:Alpha source',
            'session.follow.sources.stopForSource:Beta source',
        ]);
        expect(new Set(labels).size).toBe(2);
        await screen.unmount();
    });

    it('opens a source panel from its row with its own title, Stop updates and Done, and Done closes it', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'important' },
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        followState.rows = { 'home-a': {
            'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', metadata: { name: 'Alpha source', path: '/repo/alpha' }, encryptionMode: 'plain' }),
        } };
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })} serverId="home-a" destinationMachineId={null}
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).not.toBeNull());
        // The row is a compact index entry: nothing is edited inline until it is opened.
        expect(screen.findByTestId('session-follow-source-source-a-panel')).toBeNull();
        expect(screen.findByTestId('session-follow-source-source-a-remove')).toBeNull();
        await openSource(screen, 'source-a');
        expect(screen.findByTestId('session-follow-source-source-a-panel')).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('session.follow.sources.row:Alpha source');
        expect(text).toContain('session.follow.sources.panelSubtitle');
        expect(screen.findByTestId('session-follow-source-source-a-remove')).not.toBeNull();
        await act(async () => { screen.findByTestId('session-follow-source-source-a-done')?.props.onPress?.(); });
        expect(screen.findByTestId('session-follow-source-source-a-panel')).toBeNull();
        expect(api.remove).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('keeps a Machine Run distinct from an opaque Session id with the same colon-shaped spelling', () => {
        expect(followSourceKey({ kind: 'execution_run', sessionId: 'machine:machine-one', runId: 'same-run' }))
            .not.toBe(followSourceKey({ kind: 'execution_run', machineId: 'machine-one', runId: 'same-run' }));
    });

    it('lists every source kind as a row that opens the same panel and writes through its exact source ref', async () => {
        const other = (source: Record<string, string>, extra: Record<string, unknown> = {}) => ({
            source, destinationSessionId: 'destination-a', policy: { preset: 'important' as const }, deliveryState: 'eligible' as const,
            sourceAvailability: 'available' as const, hasPendingUpdates: null, relation: 'follower' as const, ...extra,
        });
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [
            { sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false },
            other({ kind: 'discussion', discussionId: 'disc-1' }),
            other({ kind: 'execution_run', sessionId: 'source-a', runId: 'run-1' }),
            other({ kind: 'workflow_run', runId: 'wf-1' }, { sourceAvailability: 'unavailable' }),
        ] } });
        api.remove.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        api.set.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        followState.rows = { 'home-a': {
            'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', metadata: { name: 'Alpha source', path: '/repo/alpha' }, encryptionMode: 'plain' }),
        } };
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })} serverId="home-a" destinationMachineId={null}
        />);
        const executionKey = followSourceKey({ kind: 'execution_run', sessionId: 'source-a', runId: 'run-1' });
        for (const key of ['source-a', 'discussion:disc-1', executionKey, 'workflow_run:wf-1']) {
            await vi.waitFor(() => expect(findSourceRow(screen, key)).not.toBeNull());
        }
        // Each kind is named by its own owner, and a source the receiver can no longer read says so instead of a level.
        expect(findSourceRow(screen, executionKey)?.props.title)
            .toBe('session.follow.sources.executionRun:Alpha source');
        expect(findSourceRow(screen, 'workflow_run:wf-1')?.props.subtitle).toBe('session.follow.sources.sourceUnavailable');

        await openSource(screen, 'discussion:disc-1');
        expect(screen.findByTestId('session-follow-source-discussion:disc-1-panel')).not.toBeNull();
        expect(screen.getTextContent()).toContain('session.follow.sources.row:session.follow.sources.kindDiscussion');
        await act(async () => { sourcePresetSegment(screen, 'discussion:disc-1', 'quiet')?.props.onPress?.(); await Promise.resolve(); });
        expect(api.set).toHaveBeenCalledWith(expect.objectContaining({
            destinationSessionId: 'destination-a', source: { kind: 'discussion', discussionId: 'disc-1' },
        }));
        await act(async () => { screen.findByTestId('session-follow-source-discussion:disc-1-remove')?.props.onPress?.(); await Promise.resolve(); });
        await vi.waitFor(() => expect(api.remove).toHaveBeenCalledWith({
            serverId: 'home-a', destinationSessionId: 'destination-a', source: { kind: 'discussion', discussionId: 'disc-1' },
        }));
        // Non-Session sources have no encrypted source key to prepare.
        expect(preparation.run).not.toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'disc-1' }));
        await screen.unmount();
    });

    it('shows a rule-only Following as rule rows with a live count, and edits or stops that rule in the same panel', async () => {
        const filter = { show: 'sessions', startedBy: ['you', 'triggers', 'agents'], scope: 'all_accessible', attention: 'any',
            homeServerIds: [RULE_HOME], audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, source: 'all',
            projects: { include: [{ serverId: RULE_HOME, projectKey: 'payments' }], exclude: [] }, statuses: { include: ['failed'], exclude: [] } };
        const rule = { ruleId: 'rule-1', receiver: { kind: 'session', sessionId: 'destination-a' }, version: 3,
            sources: [], inception: { createdAt: 1 }, definition: { v: 1, enabled: true, filter, policy: { preset: 'important' } } };
        const writes = await activateRuleCensus(rule);
        api.remove.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        followAction.execute.mockImplementation(async ({ actionId }: { actionId: string }) => actionId === 'follow.preview'
            ? { kind: 'ok', value: { coverage: 'complete', matchCount: 4, matches: [], unavailable: [], overlaps: [] } }
            : { kind: 'failed', error: 'unavailable' });
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })} serverId={RULE_HOME} destinationMachineId={null}
        />);
        await vi.waitFor(() => expect(api.list.mock.calls.at(-1)?.[3]).toMatchObject({
            rules: { status: 'ready', serverId: RULE_HOME, accountId: 'follow-account', mode: 'plain' },
        }));
        // Not an empty Following: the rule is the row, counted by the canonical preview for this receiver.
        await vi.waitFor(() => expect(findSourceRow(screen, 'rule:rule-1')?.props.subtitle).toBe('sessionCoordinator.make.count'));
        expect(screen.findAllByTestId('session-follow-sources-empty')).toHaveLength(0);
        expect(findSourceRow(screen, 'rule:rule-1')?.props.title).toBe('session.follow.sources.ruleMatching');
        await openSource(screen, 'rule:rule-1');
        expect(screen.findByTestId('session-follow-source-rule:rule-1-panel')).not.toBeNull();
        await vi.waitFor(() => expect(sourcePresetSegment(screen, 'rule:rule-1', 'quiet')?.props.disabled).toBe(false));
        await act(async () => { sourcePresetSegment(screen, 'rule:rule-1', 'quiet')?.props.onPress?.(); await Promise.resolve(); });
        // The rule's whole definition is written at the version this list read; its filter is untouched.
        await vi.waitFor(() => expect(writes).toEqual([expect.objectContaining({
            receiver: { kind: 'session', sessionId: 'destination-a' }, expectedVersion: 3,
            content: { t: 'plain', v: { v: 1, enabled: true, filter, policy: expect.objectContaining({ preset: 'quiet' }) } },
        })]));
        expect(api.set).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(readControlDisabled(screen, 'session-follow-source-rule:rule-1-remove')).toBe(false));
        await act(async () => { screen.findByTestId('session-follow-source-rule:rule-1-remove')?.props.onPress?.(); await Promise.resolve(); });
        await vi.waitFor(() => expect(api.remove).toHaveBeenCalledWith({
            serverId: RULE_HOME, destinationSessionId: 'destination-a', source: { kind: 'rule', ruleId: 'rule-1' }, expectedVersion: 4,
        }));
        await screen.unmount();
    });

    describe('a rule panel edits which sessions the rule follows', () => {
        const baseFilter = { show: 'sessions', startedBy: ['you', 'triggers', 'agents'], scope: 'all_accessible', attention: 'any',
            homeServerIds: [RULE_HOME], audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, source: 'all',
            projects: { include: [], exclude: [{ serverId: RULE_HOME, projectKey: 'payments' }] } };
        const rule = { ruleId: 'rule-1', receiver: { kind: 'session', sessionId: 'destination-a' }, version: 3,
            sources: [], inception: { createdAt: 1 }, definition: { v: 1, enabled: true, filter: baseFilter, policy: { preset: 'important' } } };
        let writes: Awaited<ReturnType<typeof activateRuleCensus>>;
        beforeEach(async () => {
            writes = await activateRuleCensus(rule);
            api.remove.mockResolvedValue({ kind: 'ok', value: { changed: true } });
            followAction.execute.mockImplementation(async ({ actionId }: { actionId: string }) => {
                if (actionId === 'follow.preview') return { kind: 'ok', value: { coverage: 'complete', matchCount: 2, matches: [], unavailable: [], overlaps: [] } };
                return { kind: 'failed', error: 'unavailable' };
            });
        });
        async function press(screen: Awaited<ReturnType<typeof renderSettingsView>>, testID: string) {
            await vi.waitFor(() => expect(screen.findAllByTestId(testID).find((node) => typeof node.props.onPress === 'function'), testID).toBeDefined());
            await vi.waitFor(() => expect(readControlDisabled(screen, testID), testID).not.toBe(true));
            await act(async () => { screen.findAllByTestId(testID).find((node) => typeof node.props.onPress === 'function')?.props.onPress?.(); await Promise.resolve(); });
        }

        it('on the anchored panel: the shared filter editor saves a new filter at the read version, and a left-out project comes back with Undo', async () => {
            const screen = await renderSettingsView(<SessionFollowSourcesEditor
                destination={createSessionFixture({ id: 'destination-a' })} serverId={RULE_HOME} destinationMachineId={null}
            />);
            await openSource(screen, 'rule:rule-1');
            // The persisted "Leave them to this one" exclusion is visible, with its way back.
            expect(screen.findByTestId('session-follow-source-rule:rule-1-left-out-payments')).not.toBeNull();

            // Which sessions: the Sessions list's own editor, inline in the same panel; nothing is written until Save.
            await press(screen, 'session-follow-source-rule:rule-1-filter');
            await press(screen, 'collection-filter-field:statuses');
            await press(screen, 'collection-filter-value:statuses:failed');
            expect(writes).toHaveLength(0);
            await press(screen, 'collection-filter-done');
            await vi.waitFor(() => expect(writes).toHaveLength(1));
            expect(writes[0]).toMatchObject({ expectedVersion: 3, content: { t: 'plain', v: { policy: { preset: 'important' } } } });
            const saved = writes[0]!.content;
            if (saved.t !== 'plain') throw new Error('The plain Account must write plain rule content');
            expect(saved.v.filter.statuses?.include.length).toBeGreaterThan(0);
            expect(saved.v.filter.projects).toEqual(baseFilter.projects);
            // Saving returns to the rule's panel.
            await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-rule:rule-1-filter')).not.toBeNull());

            // Include again writes the rule without the exclusion; Undo puts it back at the version that write produced.
            await press(screen, 'session-follow-source-rule:rule-1-left-out-payments-include');
            await vi.waitFor(() => expect(writes).toHaveLength(2));
            expect(writes[1]!.content).toMatchObject({ t: 'plain', v: { filter: expect.not.objectContaining({ projects: expect.anything() }) } });
            await press(screen, 'session-follow-source-rule:rule-1-left-out-undo');
            await vi.waitFor(() => expect(writes).toHaveLength(3));
            // Writes so far: Save (→ 4), Include again (→ 5); Undo is bound to the version Include again produced.
            expect(writes[2]).toMatchObject({ expectedVersion: 5, content: { t: 'plain', v: { filter: { projects: baseFilter.projects } } } });
            await screen.unmount();
        });

        it('on the phone page: the same filter step and writer, and Stop updates leaves the page', async () => {
            const onClose = vi.fn();
            const screen = await renderPage(<SessionFollowSourcesEditor
                destination={createSessionFixture({ id: 'destination-a' })} serverId={RULE_HOME} destinationMachineId={null}
                page={{ sourceKey: 'rule:rule-1', onClose, frame: (parts) => <>{parts.body}{parts.footer}</> }}
            />);
            await press(screen, 'session-follow-source-rule:rule-1-filter');
            await press(screen, 'collection-filter-field:statuses');
            await press(screen, 'collection-filter-value:statuses:failed');
            await press(screen, 'collection-filter-done');
            await vi.waitFor(() => expect(writes).toHaveLength(1));
            expect(writes[0]).toMatchObject({ expectedVersion: 3 });
            await press(screen, 'session-follow-source-rule:rule-1-remove');
            await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
            expect(api.remove).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'rule', ruleId: 'rule-1' } }));
            await screen.unmount();
        });
    });

    it('keeps the page frame when its source is gone or its list could not be read, with the way out', async () => {
        api.list.mockResolvedValueOnce({ kind: 'ok', value: { sources: [], rules: [] } });
        const onClose = vi.fn();
        const frame = (parts: Readonly<{ title: string; body: React.ReactNode; footer: React.ReactNode }>) => <>{parts.body}{parts.footer}</>;
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })} serverId="home-a" destinationMachineId={null}
            page={{ sourceKey: 'source-a', onClose, frame }}
        />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('session.follow.sources.sourceUnavailable'));
        await act(async () => { screen.findByTestId('session-follow-source-page-done')?.props.onPress?.(); await Promise.resolve(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        await screen.unmount();

        api.list.mockResolvedValueOnce({ kind: 'failed', error: 'unavailable' });
        const failed = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })} serverId="home-a" destinationMachineId={null}
            page={{ sourceKey: 'source-a', onClose, frame }}
        />);
        // A failed read is not "gone": it says so and retries the read.
        await vi.waitFor(() => expect(failed.findByTestId('session-follow-sources-error')).not.toBeNull());
        expect(failed.getTextContent()).not.toContain('session.follow.sources.sourceUnavailable');
        await failed.unmount();
    });

    it('places one source panel through a pushed page with the same policy writer, and leaves the page after Stop updates', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' },
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        api.set.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        api.remove.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        const onClose = vi.fn();
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })} serverId="home-a" destinationMachineId={null}
            page={{ sourceKey: 'source-a', onClose, frame: (parts) => <>{parts.body}{parts.footer}</> }}
        />);
        await vi.waitFor(() => expect(sourcePresetSegment(screen, 'source-a', 'quiet')).toBeDefined());
        // The page shows the source's panel, not the list.
        expect(screen.findByTestId('session-follow-source-add')).toBeNull();
        await act(async () => { sourcePresetSegment(screen, 'source-a', 'important')?.props.onPress?.(); await Promise.resolve(); });
        expect(api.set).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'source-a', policy: { preset: 'important', voice: false } }));
        await act(async () => { screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.(); await Promise.resolve(); });
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(api.remove).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'source-a' }));
        await screen.unmount();
    });

    it('never paints sources returned for a previous exact destination after the destination changes', async () => {
        const first = createDeferred<Readonly<{ kind: 'ok'; value: { sources: Array<{ sourceSessionId: string; destinationSessionId: string; policy: { preset: 'quiet' }; deliveryState: 'eligible'; hasPendingUpdates: boolean }> } }>>();
        const second = createDeferred<Readonly<{ kind: 'ok'; value: { sources: Array<{ sourceSessionId: string; destinationSessionId: string; policy: { preset: 'quiet' }; deliveryState: 'eligible'; hasPendingUpdates: boolean }> } }>>();
        api.list
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);

        const firstDestination = createSessionFixture({ id: 'destination-a' });
        const secondDestination = createSessionFixture({ id: 'destination-b' });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={firstDestination}
            serverId="home-a"
            destinationMachineId={null}
        />);

        await switchFixtureHome('home-b');
        await screen.update(<SessionFollowSourcesEditor
            destination={secondDestination}
            serverId="home-b"
            destinationMachineId={null}
        />);
        await act(async () => {
            second.resolve({ kind: 'ok', value: { sources: [{
                sourceSessionId: 'source-b', destinationSessionId: 'destination-b', policy: { preset: 'quiet' as const }, deliveryState: 'eligible', hasPendingUpdates: false,
            }] } });
            await second.promise;
        });
        expect(screen.findByTestId('session-follow-source-source-b')).not.toBeNull();

        await act(async () => {
            first.resolve({ kind: 'ok', value: { sources: [{
                sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const }, deliveryState: 'eligible', hasPendingUpdates: false,
            }] } });
            await first.promise;
        });
        expect(screen.findByTestId('session-follow-source-source-b')).not.toBeNull();
        expect(screen.findByTestId('session-follow-source-source-a')).toBeNull();
        await screen.unmount();
    });

    it('ignores a completed removal from the previous destination while the current destination mutation remains active', async () => {
        const oldRemoval = createDeferred<Readonly<{ kind: 'ok'; value: { changed: true } }>>();
        const currentModeUpdate = createDeferred<Readonly<{ kind: 'ok'; value: { changed: true } }>>();
        const focused = vi.fn();
        api.list.mockImplementation(async (input: Readonly<{ sessionId: string }>) => ({
            kind: 'ok',
            value: {
                sources: input.sessionId === 'destination-a'
                    ? [{
                        sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const },
                        deliveryState: 'eligible' as const, hasPendingUpdates: false,
                    }]
                    : [{
                        sourceSessionId: 'source-b', destinationSessionId: 'destination-b', policy: { preset: 'quiet' as const },
                        deliveryState: 'eligible' as const, hasPendingUpdates: false,
                    }],
            },
        }));
        api.remove.mockReturnValueOnce(oldRemoval.promise);
        api.set.mockReturnValueOnce(currentModeUpdate.promise);
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
            },
            'home-b': {
                'source-b': createSessionListRenderableSessionFixture({ id: 'source-b', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a', active: true, operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
                },
            })],
            'home-b': [createMachineFixture({
                id: 'runner-b', active: true, operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
                },
            })],
        };

        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />, {
            createNodeMock: (element) => ({ focus: () => focused((element.props as { testID?: string }).testID) }),
        });
        await openSource(screen, 'source-a');
        await act(async () => {
            screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.();
            await Promise.resolve();
        });

        await switchFixtureHome('home-b');
        await screen.update(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-b' })}
            serverId="home-b"
            destinationMachineId="runner-b"
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-b')).not.toBeNull());
        await act(async () => {
            findSourceRow(screen, 'source-b')?.props.onPress?.();
            await Promise.resolve();
        });
        await act(async () => {
            sourcePresetSegment(screen, 'source-b', 'everything')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(api.set).toHaveBeenCalledWith({
            serverId: 'home-b',
            destinationSessionId: 'destination-b',
            sourceSessionId: 'source-b',
            policy: { preset: 'everything', voice: false },
        });
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);

        await act(async () => {
            oldRemoval.resolve({ kind: 'ok', value: { changed: true } });
            await oldRemoval.promise;
            await Promise.resolve();
        });
        expect(focused).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-follow-sources-error')).toBeNull();
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);

        await act(async () => {
            currentModeUpdate.resolve({ kind: 'ok', value: { changed: true } });
            await currentModeUpdate.promise;
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(false));
        await screen.unmount();
    });

    it('ignores a failed policy update from the previous destination while the current destination removal remains active', async () => {
        const oldModeUpdate = createDeferred<Readonly<{ kind: 'error'; error: string }>>();
        const currentRemoval = createDeferred<Readonly<{ kind: 'ok'; value: { changed: true } }>>();
        api.list.mockImplementation(async (input: Readonly<{ sessionId: string }>) => ({
            kind: 'ok',
            value: {
                sources: input.sessionId === 'destination-a'
                    ? [{
                        sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const },
                        deliveryState: 'eligible' as const, hasPendingUpdates: false,
                    }]
                    : [{
                        sourceSessionId: 'source-b', destinationSessionId: 'destination-b', policy: { preset: 'quiet' as const },
                        deliveryState: 'eligible' as const, hasPendingUpdates: false,
                    }],
            },
        }));
        api.set.mockReturnValueOnce(oldModeUpdate.promise);
        api.remove.mockReturnValueOnce(currentRemoval.promise);
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
            },
            'home-b': {
                'source-b': createSessionListRenderableSessionFixture({ id: 'source-b', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a', active: true, operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
                },
            })],
            'home-b': [createMachineFixture({
                id: 'runner-b', active: true, operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true },
                },
            })],
        };

        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).not.toBeNull());
        await act(async () => {
            findSourceRow(screen, 'source-a')?.props.onPress?.();
            await Promise.resolve();
        });
        await act(async () => {
            sourcePresetSegment(screen, 'source-a', 'everything')?.props.onPress?.();
            await Promise.resolve();
        });

        await switchFixtureHome('home-b');
        await screen.update(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-b' })}
            serverId="home-b"
            destinationMachineId="runner-b"
        />);
        await openSource(screen, 'source-b');
        await act(async () => {
            screen.findByTestId('session-follow-source-source-b-remove')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(api.remove).toHaveBeenCalledWith({
            serverId: 'home-b',
            destinationSessionId: 'destination-b',
            sourceSessionId: 'source-b',
        });
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);

        await act(async () => {
            oldModeUpdate.resolve({ kind: 'error', error: 'old_destination_failed' });
            await oldModeUpdate.promise;
            await Promise.resolve();
        });
        expect(screen.findByTestId('session-follow-sources-error')).toBeNull();
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);

        await act(async () => {
            currentRemoval.resolve({ kind: 'ok', value: { changed: true } });
            await currentRemoval.promise;
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(false));
        await screen.unmount();
    });

    it('retries the exact failed Stop following instead of reloading the list', async () => {
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const },
            deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        let removed = false;
        api.list.mockImplementation(async () => ({
            kind: 'ok',
            value: { sources: removed ? [] : [relation] },
        }));
        api.remove.mockImplementationOnce(async () => ({ kind: 'error', error: 'unavailable' }));
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({ id: 'runner-a', active: true })],
        };

        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await openSource(screen, 'source-a');

        await act(async () => {
            screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-sources-error')).not.toBeNull());

        // A definite rejection of Stop following is not retried by listing again.
        api.remove.mockImplementationOnce(async () => {
            removed = true;
            return { kind: 'ok', value: { changed: true } };
        });
        await act(async () => {
            screen.findByTestId('session-follow-sources-error')?.props.onPress?.();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(api.remove).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).toBeNull());
        expect(screen.findByTestId('session-follow-sources-error')).toBeNull();
        await screen.unmount();
    });

    it('keeps loaded source choices visible but disables mutations while offline', async () => {
        connectivity.online = false;
        api.list.mockResolvedValueOnce({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const }, deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId={null}
        />);

        await act(async () => {});
        expect(findSourceRow(screen, 'source-a')).not.toBeNull();
        await openSource(screen, 'source-a');
        expect(readControlDisabled(screen, 'session-follow-source-source-a-remove')).toBe(true);
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);
        expect(screen.findByTestId('session-follow-sources-offline')).not.toBeNull();

        await act(async () => { screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.(); });
        expect(api.remove).not.toHaveBeenCalled();
        connectivity.online = true;
        await screen.unmount();
    });

    it('reads an eligible and an archived relation the same way for sight and for a screen reader', async () => {
        // The committed-edge read may be re-issued when the mount effect settles,
        // so answer every call rather than depending on effect scheduling.
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [
            { sourceSessionId: 'source-a', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const }, deliveryState: 'eligible', hasPendingUpdates: false },
            { sourceSessionId: 'source-b', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const }, deliveryState: 'paused_archived', hasPendingUpdates: false },
        ] } });
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
                'source-b': createSessionListRenderableSessionFixture({ id: 'source-b', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };

        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => {
            expect(screen.findByTestId('session-follow-source-source-a')).not.toBeNull();
        });

        // The accessibility label restates the visible status, so an eligible row
        // must not announce the Account-Follow word "Following" while the subtitle
        // a sighted person reads says the source is included in the next turn.
        await vi.waitFor(() => {
            const eligible = findSourceRow(screen, 'source-a');
            expect(eligible?.props.subtitle).toBe('session.follow.policy.quiet');
            expect(eligible?.props.accessibilityLabel).toContain('session.follow.policy.quiet');
            expect(eligible?.props.accessibilityLabel).not.toContain('session.follow.following');
        });

        // Archive pauses the relation between two Sessions; the Account Follow
        // sentence about "this session" would describe the wrong relationship.
        expect(findSourceRow(screen, 'source-b')?.props.subtitle)
            .toBe('session.follow.sources.pausedArchived');
        await screen.unmount();
    });

    it('does not enter Runner key preparation for a known plaintext source', async () => {
        api.list.mockResolvedValueOnce({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-plain', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const }, deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        followState.rows = {
            'home-a': {
                'source-plain': createSessionListRenderableSessionFixture({ id: 'source-plain', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };

        const screen = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);

        await act(async () => { await Promise.resolve(); });
        expect(preparation.run).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-follow-source-source-plain')).not.toBeNull();
        await screen.unmount();
    });

    it('uses the exact destination Machine to distinguish waiting from an unsupported runtime without preparing', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-e2ee', destinationSessionId: 'destination-a', policy: { preset: 'quiet' as const }, deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        followState.rows = {
            'home-a': {
                'source-e2ee': createSessionListRenderableSessionFixture({ id: 'source-e2ee', encryptionMode: 'e2ee' }),
            },
        };

        const unavailable = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(
            findSourceRow(unavailable, 'source-e2ee')?.props.subtitle,
        ).toBe('session.follow.sources.waitingRuntime'));
        expect(preparation.run).not.toHaveBeenCalled();
        await unavailable.unmount();

        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: {},
            })],
        };
        const unsupported = await renderPage(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(
            findSourceRow(unsupported, 'source-e2ee')?.props.subtitle,
        ).toBe('session.follow.sources.unsupported'));
        expect(preparation.run).not.toHaveBeenCalled();
        await unsupported.unmount();
    });
});
