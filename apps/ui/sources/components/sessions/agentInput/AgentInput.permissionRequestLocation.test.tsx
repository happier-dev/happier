import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastPermissionPromptCardProps: any = null;
let messagesVersion = 0;

const toolMessageId = 't1';
const sessionId = 'session-1';
const permissionId = 'perm-1';
const committedMessageIdsOldestFirstRef = [toolMessageId];

const messagesByIdRef: Record<string, any> = {
    [toolMessageId]: {
        kind: 'tool-call',
        id: toolMessageId,
        localId: null,
        createdAt: 1,
        tool: {
            id: `call:${toolMessageId}`,
            name: 'write_file',
            state: 'running',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
        },
        children: [],
    },
};

const permissionRequests = [{ id: permissionId, tool: 'write_file', arguments: {} }];

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, null),
        Platform: { ...rn.Platform, OS: 'ios', select: (v: any) => v.ios },
        useWindowDimensions: () => ({ width: 800, height: 600 }),
        Dimensions: {
            get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
        },
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
                colors: {
                    input: { background: '#fff' },
                    accent: { indigo: '#5856D6' },
                    box: {
                        error: { background: '#ffecec', border: '#ffa39e', text: '#a8071a' },
                        warning: { background: '#fff7e6', border: '#ffd591', text: '#ad6800' },
                    },
                    button: {
                        primary: { background: '#000', tint: '#fff' },
                        secondary: { tint: '#000', surface: '#fff' },
                    },
                    radio: { active: '#000', inactive: '#ddd' },
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    success: '#0a0',
                    warning: '#f90',
                    warningCritical: '#f00',
                    textDestructive: '#a00',
                    surfacePressed: '#eee',
                    surfacePressedOverlay: '#eee',
                    surface: '#fff',
                    shadow: { color: '#000' },
                    permission: {
                        acceptEdits: '#0a0',
                        bypass: '#0a0',
                        plan: '#0a0',
                        readOnly: '#0a0',
                        safeYolo: '#0a0',
                        yolo: '#0a0',
                    },
                    surfaceHighest: '#fafafa',
                    groupped: { background: '#fff' },
                    header: { background: '#fff', tint: '#000' },
                    textLink: '#00f',
                    agentEventText: '#666',
                },
            };
            return typeof styles === 'function' ? styles(theme) : styles;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { background: '#fff' },
                accent: { indigo: '#5856D6' },
                box: {
                    error: { background: '#ffecec', border: '#ffa39e', text: '#a8071a' },
                    warning: { background: '#fff7e6', border: '#ffd591', text: '#ad6800' },
                },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000', surface: '#fff' },
                },
                radio: { active: '#000', inactive: '#ddd' },
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                success: '#0a0',
                warning: '#f90',
                warningCritical: '#f00',
                textDestructive: '#a00',
                surfacePressed: '#eee',
                surfacePressedOverlay: '#eee',
                surface: '#fff',
                shadow: { color: '#000' },
                permission: {
                    acceptEdits: '#0a0',
                    bypass: '#0a0',
                    plan: '#0a0',
                    readOnly: '#0a0',
                    safeYolo: '#0a0',
                    yolo: '#0a0',
                },
                surfaceHighest: '#fafafa',
                groupped: { background: '#fff' },
                header: { background: '#fff', tint: '#000' },
                textLink: '#00f',
                agentEventText: '#666',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('expo-image', () => ({
    Image: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/modal', () => ({
    Modal: { alert: () => {} },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 920 },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'profiles') return [];
        if (key === 'agentInputEnterToSend') return true;
        if (key === 'agentInputActionBarLayout') return 'wrap';
        if (key === 'agentInputChipDensity') return 'labels';
        if (key === 'agentInputHistoryScope') return 'perSession';
        if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
        if (key === 'permissionPromptSurface') return 'composer';
        return null;
    },
    useSettings: () => ({
        profiles: [],
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: 'labels',
        agentInputHistoryScope: 'perSession',
        sessionPermissionModeApplyTiming: 'immediate',
        permissionPromptSurface: 'composer',
    }),
    useSessionTranscriptIds: () => ({ ids: committedMessageIdsOldestFirstRef as any, isLoaded: true }),
    useSessionMessagesById: () => messagesByIdRef,
    useSessionMessagesVersion: (_sid: string, enabled?: boolean) => (enabled === false ? 0 : messagesVersion),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
    describeEffectiveModelMode: () => ({ effectiveModelId: 'default' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeBadgeLabelForAgentType: () => 'Default',
    getPermissionModeLabelForAgentType: () => 'Default',
    getPermissionModeOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    getPermissionModeTitleForAgentType: () => 'Permissions',
}));

vi.mock('@/sync/domains/permissions/describeEffectivePermissionMode', () => ({
    describeEffectivePermissionMode: () => ({ effectiveMode: 'default' }),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: (props: any) => {
        lastPermissionPromptCardProps = props;
        return React.createElement('PermissionPromptCard', props);
    },
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({
        getPrevious: () => null,
        getNext: () => null,
        push: () => {},
        reset: () => {},
    }),
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/autocomplete/useActiveWord', () => ({
    useActiveWord: () => ({ activeWord: null, setActiveWord: () => {} }),
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], null, () => {}, () => {}],
}));

vi.mock('./components/AgentInputAutocomplete', () => ({
    AgentInputAutocomplete: () => null,
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement('FloatingOverlay', null, children),
}));

describe('AgentInput (permission tool location)', () => {
    it('updates the PermissionPromptCard location when tool-call permission id appears (even if messagesById is mutated in-place)', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastPermissionPromptCardProps = null;
        messagesVersion = 0;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AgentInput
                    value=""
                    placeholder="x"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    sessionId={sessionId}
                    metadata={null as any}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    permissionRequests={permissionRequests as any}
                />
            );
        });

        expect(lastPermissionPromptCardProps?.location).toBeNull();

        // Mutate messagesById in-place to simulate store behavior (map identity is stable).
        messagesByIdRef[toolMessageId] = {
            ...messagesByIdRef[toolMessageId],
            tool: {
                ...messagesByIdRef[toolMessageId].tool,
                permission: { id: permissionId, status: 'pending' },
            },
        };
        messagesVersion += 1;

        await act(async () => {
            tree!.update(
                <AgentInput
                    value=""
                    placeholder="x"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    sessionId={sessionId}
                    metadata={null as any}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    permissionRequests={permissionRequests as any}
                />
            );
        });

        expect(lastPermissionPromptCardProps?.location).toEqual({
            kind: 'top',
            messageId: toolMessageId,
            seq: null,
        });
    });
});
