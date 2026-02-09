import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import type { CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { DetectedClisList } from './DetectedClisList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: {
        select: <T,>(options: { default?: T; ios?: T }) => options.default ?? options.ios ?? null,
    },
    Text: 'Text',
    View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#666', status: { connected: '#0a0' } } } }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'codex'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: (agentId: string) => {
        if (agentId === 'claude') {
            return { displayNameKey: 'agentInput.agent.claude', cli: { detectKey: 'claude' } };
        }
        if (agentId === 'codex') {
            return { displayNameKey: 'agentInput.agent.codex', cli: { detectKey: 'codex' } };
        }
        return { displayNameKey: `agent.${agentId}`, cli: { detectKey: agentId } };
    },
}));

function buildOkResult(data: Record<string, unknown>): CapabilityDetectResult {
    return {
        ok: true,
        checkedAt: 1,
        data,
    };
}

function buildState(params: {
    status: 'loaded' | 'error';
    results?: Record<string, CapabilityDetectResult>;
}): MachineCapabilitiesCacheState {
    if (!params.results) {
        return { status: params.status };
    }

    return {
        status: params.status,
        snapshot: {
            response: {
                protocolVersion: 1,
                results: params.results as unknown as Partial<Record<CapabilityId, CapabilityDetectResult>>,
            },
        },
    };
}

function renderList(state: MachineCapabilitiesCacheState): renderer.ReactTestRenderer {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(React.createElement(DetectedClisList, { state }));
    });
    return tree!;
}

function findItems(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('Item');
}

function findItemByTitle(tree: renderer.ReactTestRenderer, title: string): ReactTestInstance | undefined {
    return findItems(tree).find((node) => node.props.title === title);
}

function subtitleContainsText(value: unknown, expectedText: string): boolean {
    if (typeof value === 'string') return value === expectedText;
    if (React.isValidElement(value)) {
        const child = value.props?.children;
        if (typeof child === 'string') return child === expectedText;
        if (Array.isArray(child)) return child.some((entry) => subtitleContainsText(entry, expectedText));
    }
    return false;
}

describe('DetectedClisList', () => {
    it('renders the last known snapshot when refresh fails and suppresses unknown capability keys', () => {
        const tree = renderList(buildState({
            status: 'error',
            results: {
                'cli.claude': buildOkResult({ available: true, version: 'v1.0.0', resolvedPath: '/usr/bin/claude' }),
                'cli.codex': buildOkResult({ available: true, version: '1.2.3', resolvedPath: '/usr/bin/codex' }),
                'tool.tmux': buildOkResult({ available: false }),
                'tool.unknown-custom': buildOkResult({ available: true }),
            },
        }));

        const titles = findItems(tree).map((node) => node.props.title);
        expect(titles).toEqual(expect.arrayContaining(['agentInput.agent.claude', 'agentInput.agent.codex', 'tmux']));
        expect(titles).not.toContain('machine.detectedCliUnknown');
        expect(titles).not.toContain('tool.unknown-custom');
    });

    it('shows unknown status row when in error state without a snapshot', () => {
        const tree = renderList(buildState({ status: 'error' }));
        const titles = findItems(tree).map((node) => node.props.title);
        expect(titles).toEqual(['machine.detectedCliUnknown']);
    });

    it('renders mixed availability states from loaded snapshot', () => {
        const tree = renderList(buildState({
            status: 'loaded',
            results: {
                'cli.claude': buildOkResult({ available: true, version: '1.0.0', resolvedPath: '/usr/bin/claude' }),
                'cli.codex': buildOkResult({ available: true }),
                'tool.tmux': buildOkResult({ available: false }),
            },
        }));

        const claudeItem = findItemByTitle(tree, 'agentInput.agent.claude');
        const codexItem = findItemByTitle(tree, 'agentInput.agent.codex');
        const tmuxItem = findItemByTitle(tree, 'tmux');

        expect(claudeItem).toBeTruthy();
        expect(codexItem).toBeTruthy();
        expect(tmuxItem).toBeTruthy();
        expect(subtitleContainsText(codexItem?.props.subtitle, 'machine.detectedCliUnknown')).toBe(true);
        expect(subtitleContainsText(tmuxItem?.props.subtitle, 'machine.detectedCliNotDetected')).toBe(true);
    });
});
