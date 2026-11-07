// @vitest-environment jsdom
import { act, cloneElement, type ReactElement } from 'react';
import { createHash } from 'node:crypto';
import * as React from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, createTestResourceInvocationContext, type PluginUiTestkit, type PluginUiSemanticSurfaceAdapter } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { testkitEntryRef, testkitObservation, TESTKIT_SOURCE_INSTANCE_ID } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { toTriageListWireRows } from '../../projection/listWindowWire.js';
import { acquireTriageListWindow, refreshTriageListWindow, setTriageListWindowLens } from '../../ui/window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../../ui/window/ephemeralSharedScope.test-support.js';
import { TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME } from '../sessionLinksResource.js';
import type { TriageReadSourceSessionLinksResultV1 } from '../../actions/sessionLinksProtocol.js';
import { useTriageSessionLinkCandidates } from './useSessionLinkCandidates.js';
import { createPluginUiHostApiResourceClient, createPluginUiResourceStore, type PluginUiResourceStore } from '../../../../../plugin-ui/src/hostApi/resourceStore.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY = testkitEntryRef();
const SESSION = 'session-link-picker';
const mounted: PluginUiTestkit[] = [];
const releases: Array<() => void> = [];

async function readRelationsResource(read: () => Promise<TriageReadSourceSessionLinksResultV1>) {
    // Replace the host Action transport only; resource parsing and retained projection stay real.
    const text = await TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.read(createTestResourceInvocationContext({
        context: { kind: 'session', sessionId: SESSION }, signal: new AbortController().signal,
        readAction: async () => ({ ok: true, result: await read() }),
    }));
    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    return { contentType: 'application/json', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes };
}

const probe = defineUiSurface(() => {
    const result = useTriageSessionLinkCandidates(SESSION, 'NORMALIZER repository');
    return <Text value={`${result.status}:${result.candidates.map(({ entry, alreadyLinked }) => `${entry.title}:${alreadyLinked}`).join(',')}`} />;
});

function resourceAdapter(scope: ReturnType<typeof createTriageEphemeralSharedScopeFixture>): PluginUiSemanticSurfaceAdapter<typeof probe> {
    const base = createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope });
    return { async mount(input) {
        function HostedPicker(context: RenderContext): ReactElement {
            // The host installs this private Resource store after rendering the author's surface.
            const store = React.useMemo<PluginUiResourceStore>(() => {
                const resourceStore = createPluginUiResourceStore({ client: createPluginUiHostApiResourceClient(context.hostApi), pluginId: 'happier.triage' });
                return { ...resourceStore, requiresMachine(resource) {
                    if (typeof resource !== 'string' && 'hostRead' in resource) return false;
                    if (typeof resource !== 'string' && resource.pluginId !== 'happier.triage') return true;
                    const id = typeof resource === 'string' ? resource : resource.localId;
                    return PLUGIN_MANIFEST.contributes.resources.find(declaration => declaration.id === id)?.execution?.target !== 'account';
                } };
            }, [context.hostApi]);
            React.useEffect(() => () => store.dispose(), [store]);
            return cloneElement(input.surface(context) as ReactElement<{ resourceStore?: PluginUiResourceStore; resourceStoreGeneration?: unknown;
                ephemeralSharedScope?: typeof scope }>, { resourceStore: store, resourceStoreGeneration: scope, ephemeralSharedScope: scope });
        }
        return base.mount({ ...input, surface: context => React.createElement(HostedPicker, context) });
    } };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
    for (const release of releases.splice(0)) release();
});

describe('the mounted Session link candidate reader', () => {
    it.each([false, true])('distinguishes a first acquisition failure from an admitted empty window (failure=%s)', async (failed) => {
        const scope = createTriageEphemeralSharedScopeFixture();
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'first-demand', mountNonce: 'first-demand-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: probe,
                surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION, agentId: 'codex' } }),
                adapter: resourceAdapter(scope),
                handlers: { readResource: () => readRelationsResource(async () => ({ kind: 'complete', links: [], lanes: [] })),
                    executeAction: async () => {
                    if (failed) throw Object.assign(new Error('Aggregate unavailable'), { code: 'unavailable' });
                    return { v: 1, configuredSources: [], configuredSourcesStatus: 'complete',
                        window: { v: 1, rows: [], lanes: [], coverage: 'complete', assembledAtMs: Date.now() } };
                } },
            });
        });
        mounted.push(fixture);
        await vi.waitFor(() => fixture.getByText(failed ? 'unavailable:' : 'ready:'));
    });

    it.each([false, true])('searches outside the page lens and settles Session coverage before saying not linked (partial=%s)', async (partial) => {
        const scope = createTriageEphemeralSharedScopeFixture();
        const lane = { sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, source: ENTRY.source,
            health: { kind: 'walkFinished' as const }, exhausted: true };
        const folded = foldTriageListWindow({ observations: [{ ...testkitObservation(), entryRef: ENTRY }], lanes: [lane],
            activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: Date.now() });
        const seedHost = { executeAction: async () => ({ v: 1,
            configuredSources: [{ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, configurationRowId: TESTKIT_SOURCE_INSTANCE_ID, source: ENTRY.source, available: true }],
            configuredSourcesStatus: 'complete',
            window: { v: 1, rows: toTriageListWireRows(folded), lanes: [lane], coverage: 'complete', assembledAtMs: Date.now() },
        }) };
        const lease = acquireTriageListWindow(seedHost, scope);
        releases.push(() => lease.release());
        await refreshTriageListWindow('manual', seedHost, scope);
        setTriageListWindowLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: 'hides-every-row' }, seedHost, scope);

        let finishPage!: () => void;
        const page = new Promise<void>((resolve) => { finishPage = resolve; });
        let sourceReads = 0;
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'session-link-probe', mountNonce: 'session-link-probe-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: probe,
                surfaceContext: createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION, agentId: 'codex' }, targetedContributions: {
                    ...createSurfaceContextFixture().targetedContributions!,
                    points: [{ pointId: 'sources', protocols: [{ protocol: { id: 'happier.triage/sources', version: 1 },
                        contributions: [{
                            contributor: { pluginId: ENTRY.source.pluginId, contributionId: ENTRY.source.localId,
                                occurrenceId: 'picker-source-1', sourceCustody: { kind: 'development', registeredRootId: 'picker-root' } },
                            protocol: { id: 'happier.triage/sources', version: 1 },
                            descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
                                kinds: [{ id: ENTRY.kindId, workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
                            operations: [], surfaces: [],
                        }],
                    }] }],
                } }),
                adapter: resourceAdapter(scope),
                handlers: {
                    readResource: () => readRelationsResource(async () => {
                        await page;
                        return { kind: partial ? 'partial' : 'complete',
                            links: ['18', ENTRY.entryId].map(entryId => ({ sessionId: SESSION,
                                entryRef: { ...ENTRY, entryId }, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, linkedAtMs: 1,
                                displayPath: `example/repository #${entryId}` })),
                            lanes: [{ source: ENTRY.source, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, displayLabel: 'Example forge', kindIds: [ENTRY.kindId],
                                health: partial ? { kind: 'partial', unavailableRefs: [{ ...ENTRY, collisionScope: 'account:unreadable' }] }
                                    : { kind: 'complete' } }],
                        };
                    }),
                    executeAction: async () => { sourceReads += 1; throw new Error('Picker mount must not refresh sources'); },
                },
            });
        });
        mounted.push(fixture);
        await expect(fixture.getByText('loading:')).resolves.toEqual({ content: 'loading:' });
        await act(async () => { finishPage(); await page; });
        const expected = `${partial ? 'partial' : 'ready'}:Replace the duplicated normalizer:true`;
        await vi.waitFor(() => fixture.getByText(expected));
        await expect(fixture.getByText(expected)).resolves.toEqual({ content: expected });
        expect(sourceReads).toBe(0);
    });
});
