// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { TriageActionV1 } from '../../settings/actions.js';
import { useTriageEntrySessionStartChoices } from './useEntrySessionStart.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ACTION = {
    actionId: 'start', label: 'Start', enabled: true, appliesTo: ['other'], profileId: null,
    workspaceMode: 'reference_only', target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
} satisfies TriageActionV1;
let observed: ReturnType<typeof useTriageEntrySessionStartChoices>;
function Probe() {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [revision, setRevision] = React.useState(0);
    observed = useTriageEntrySessionStartChoices({ action: { ...ACTION }, menuOpen });
    return <>
        <Button title={menuOpen ? 'Close menu' : 'Open menu'} onPress={() => setMenuOpen(!menuOpen)} />
        <Button title={`Unrelated render ${revision}`} onPress={() => setRevision(revision + 1)} />
    </>;
}
const surface = defineUiSurface(Probe);
let fixture: PluginUiTestkit | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });

it('loads resumable summaries only when the Start menu opens and does not reread on unrelated renders', async () => {
    const calls: string[] = [];
    fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-start-choices', mountNonce: 'fixture-start-choices-mount' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface, surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: async ({ action }) => {
            const id = typeof action === 'string' ? action : action.localId;
            calls.push(id);
            if (id === 'agents.backends.list') return { defaultTargetKey: 'backend:claude', items: [{
                targetKey: 'backend:claude', label: 'Claude Code', enabled: true,
                identity: { pluginId: 'happier.claude', localId: 'claude' },
            }] } as never;
            if (id === 'projects.list') return { items: [], truncated: false } as never;
            if (id === 'session.list') return { sessions: [{ id: 'session-a', serverId: 'home-a',
                title: 'Investigate sign in', active: false, presence: null, updatedAt: 20,
            }], nextCursor: null, hasNext: false } as never;
            throw new Error(`Unexpected Action ${id}`);
        } },
    });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(observed.defaultTarget).toMatchObject({ status: 'ready', agent: { label: 'Claude Code' } });
    expect(observed.recentSessions).toEqual({ status: 'idle' });
    expect(calls.filter((id) => id === 'session.list')).toHaveLength(0);
    const settledReads = calls.length;
    await act(async () => { await fixture!.press(await fixture!.getByRole('button', { name: 'Unrelated render 0' })); });
    expect(calls).toHaveLength(settledReads);
    await act(async () => { await fixture!.press(await fixture!.getByRole('button', { name: 'Open menu' })); });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(observed.recentSessions).toMatchObject({ status: 'ready', items: [{ id: 'session-a', serverId: 'home-a' }] });
    expect(calls.filter((id) => id === 'session.list')).toHaveLength(1);
    await act(async () => { await fixture!.press(await fixture!.getByRole('button', { name: 'Close menu' })); });
    expect(observed.recentSessions).toEqual({ status: 'idle' });
    expect(calls.filter((id) => id === 'session.list')).toHaveLength(1);
});
