// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { TriageActionV1 } from '../../settings/actions.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { useTriageEntrySessionStartChoices } from './useEntrySessionStart.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ACTION = {
    actionId: 'start', label: 'Start', enabled: true, appliesTo: ['other'], profileId: null,
    workspaceMode: 'reference_only', target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
} satisfies TriageActionV1;
let fixture: PluginUiTestkit | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });


it('keeps a named profile Agent within the Account that read it', async () => {
    const labels: Array<string | undefined> = [];
    function AccountEntry() {
        const choices = useTriageEntrySessionStartChoices({
            action: { ...ACTION, profileId: 'shared-profile-id' },
        });
        labels.push(choices.defaultTarget.status === 'ready' ? choices.defaultTarget.agent?.label : choices.settlingAgentLabel);
        return null;
    }
    const accountSurface = defineUiSurface(AccountEntry);
    const agent = (label: string) => ({
        defaultTargetKey: 'backend:account-agent', items: [{
            targetKey: 'backend:account-agent', label, enabled: true,
            identity: { pluginId: 'happier.test', localId: 'agent' },
        }],
    });
    const mount = (label: string, agents: Promise<ReturnType<typeof agent>>) => createPluginUiTestkit({
        identity: { instanceId: label, mountNonce: label },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: accountSurface, surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({
            ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        }),
        handlers: { executeAction: async ({ action }) => {
            if (action === 'sessions.spawn.profiles.list') return { items: [{
                id: 'shared-profile-id', name: 'Work', preferredAgentTargetKey: 'backend:account-agent',
            }] } as never;
            if (action === 'agents.backends.list') return await agents as never;
            throw new Error(`Unexpected Action ${String(action)}`);
        } },
    });
    fixture = await mount('account-a', Promise.resolve(agent('Account A Agent')));
    await act(async () => {});
    expect(labels.at(-1)).toBe('Account A Agent');
    await fixture.dispose();
    labels.length = 0;

    let finish!: (value: ReturnType<typeof agent>) => void;
    fixture = await mount('account-b', new Promise(resolve => { finish = resolve; }));
    try {
        expect(labels).not.toHaveLength(0);
        expect(labels.every(label => label === undefined), JSON.stringify(labels)).toBe(true);
    } finally {
        await act(async () => { finish(agent('Account B Agent')); });
    }
    expect(labels.at(-1)).toBe('Account B Agent');
});

it('preserves the named profile Agent when the same Account opens another repository', async () => {
    // The agent half of "Review with Claude Code" depends on the action alone, so a second entry in another
    // repository holds the primary's settled width from its first frame instead of drawing "Review" and growing.
    const labels: (string | undefined)[] = [];
    let release!: () => void;
    let holdReads = false;
    function Entry({ repository }: Readonly<{ repository: string }>) {
        const choices = useTriageEntrySessionStartChoices({ action: { ...ACTION, profileId: 'profile-a' },
            repository: { kind: 'github', deployment: 'github.com', repository } });
        const label = choices.defaultTarget.status === 'ready' ? choices.defaultTarget.agent?.label : choices.settlingAgentLabel;
        const paintedLabel = React.useRef(label);
        React.useLayoutEffect(() => { paintedLabel.current = label; }, [label]);
        React.useEffect(() => {
            if (repository === 'two') void Promise.resolve().then(() => { labels.push(paintedLabel.current); });
        }, [repository, label]);
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
        surface: defineUiSurface(Detail), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter({
            ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        }),
        handlers: { executeAction: async ({ action }) => {
            const id = typeof action === 'string' ? action : action.localId;
            if (holdReads) await new Promise<void>((resolve) => { release = resolve; });
            if (id === 'sessions.spawn.profiles.list') return { items: [{
                id: 'profile-a', name: 'Profile A', preferredAgentTargetKey: 'backend:claude',
            }] } as never;
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
