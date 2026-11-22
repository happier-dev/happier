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
        handlers: { readSession: async ({ sessionId }) => ({
            sessionId, serverId: 'home-a', lifecycle: 'active', runtime: 'idle', operational: 'ready',
            workStatus: { state: 'ready', bucket: 'finished', tone: 'neutral', attentionType: null, word: 'Ready' },
            pendingPermissions: [],
        }), executeAction: async ({ action }) => {
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

it('names the settled agent from the first paint of the next entry, whatever its repository, while that entry reads', async () => {
    // The agent half of "Review with Claude Code" depends on the action alone, so a second entry in another
    // repository holds the primary's settled width from its first frame instead of drawing "Review" and growing.
    const labels: (string | undefined)[] = [];
    let release!: () => void;
    let holdReads = false;
    function Entry({ repository }: Readonly<{ repository: string }>) {
        const choices = useTriageEntrySessionStartChoices({ action: { ...ACTION },
            repository: { kind: 'github', deployment: 'github.com', repository }, menuOpen: false });
        if (repository === 'two') {
            labels.push(choices.defaultTarget.status === 'ready' ? choices.defaultTarget.agent?.label : choices.settlingAgentLabel);
        }
        return null;
    }
    let showSecond!: () => void;
    function Detail() {
        const [repository, setRepository] = React.useState('one');
        showSecond = () => setRepository('two');
        return <Entry key={repository} repository={repository} />;
    }
    fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-start-width', mountNonce: 'fixture-start-width-mount' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(Detail), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: async ({ action }) => {
            const id = typeof action === 'string' ? action : action.localId;
            if (holdReads) await new Promise<void>((resolve) => { release = resolve; });
            if (id === 'agents.backends.list') return { defaultTargetKey: 'backend:claude', items: [{
                targetKey: 'backend:claude', label: 'Claude Code', enabled: true,
                identity: { pluginId: 'happier.claude', localId: 'claude' },
            }] } as never;
            if (id === 'projects.list') return { items: [], truncated: false } as never;
            throw new Error(`Unexpected Action ${id}`);
        } },
    });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    holdReads = true;
    await act(async () => { showSecond(); });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label === 'Claude Code'), JSON.stringify(labels)).toBe(true);
    holdReads = false;
    await act(async () => { release(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
});
