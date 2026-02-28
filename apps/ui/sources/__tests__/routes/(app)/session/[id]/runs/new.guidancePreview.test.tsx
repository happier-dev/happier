import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    Platform: { OS: 'web', select: (spec: any) => spec?.web ?? spec?.default },
    AppState: { currentState: 'active', addEventListener: vi.fn(), removeEventListener: vi.fn() },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#111',
                text: '#eee',
                textSecondary: '#aaa',
                divider: '#333',
                surfaceHigh: '#222',
            },
        },
    }),
    StyleSheet: { create: (v: any) => v, absoluteFillObject: {} },
}));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: 'session-1', intent: 'review' }),
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
    Stack: { Screen: () => null },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));
vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 999 } }));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => ({ id: 'session-1', metadata: { agent: 'claude' } }),
    useSettings: () => ({
        executionRunsGuidanceEnabled: true,
        executionRunsGuidanceMaxChars: 10_000,
        executionRunsGuidanceEntries: [{ id: 'g1', description: 'Prefer Claude for UI changes', enabled: true }],
    }),
    storage: { getState: () => ({ sessionListViewDataByServerId: {} }) },
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: () => ({
        claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
    }),
}));
vi.mock('@/sync/domains/settings/executionRunsGuidance', () => ({
    coerceExecutionRunsGuidanceEntries: (value: unknown) => (Array.isArray(value) ? value : []),
    buildExecutionRunsGuidanceBlock: ({ entries }: { entries: Array<{ description?: string }> }) => ({
        text: ['Execution Runs Guidance', ...entries.map((entry) => entry.description ?? '')]
            .filter(Boolean)
            .join('\n'),
    }),
}));
vi.mock('@/sync/domains/reviews/reviewEngineCatalog', () => ({
    buildAvailableReviewEngineOptions: ({
        enabledAgentIds,
        executionRunsBackends,
    }: {
        enabledAgentIds: string[];
        executionRunsBackends: Record<string, { available?: boolean; intents?: string[] }>;
    }) => {
        const capabilityIds = Object.entries(executionRunsBackends ?? {})
            .filter(([, value]) => value?.available !== false && (value?.intents ?? []).includes('review'))
            .map(([id]) => id);
        const merged = Array.from(new Set([...enabledAgentIds, ...capabilityIds]));
        return merged.map((id) => ({ id }));
    },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart: vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' })),
    sessionExecutionRunList: vi.fn(),
    sessionExecutionRunGet: vi.fn(),
    sessionExecutionRunSend: vi.fn(),
    sessionExecutionRunStop: vi.fn(),
    sessionExecutionRunAction: vi.fn(),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: vi.fn(async () => ({ ok: true, result: { results: [{ ok: true }] } })),
    }),
}));

describe('Session New Run Screen (guidance preview)', () => {
    it('renders a guidance preview when guidance is enabled and rules exist', async () => {
        const NewRunScreen = (await import('./new')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((n: any) => String(n.props.children).includes('Execution Runs Guidance'))).toBe(true);
        expect(textNodes.some((n: any) => String(n.props.children).includes('Prefer Claude for UI changes'))).toBe(true);
    });
});
