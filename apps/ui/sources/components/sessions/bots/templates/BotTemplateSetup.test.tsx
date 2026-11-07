import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { BotTemplateSetupSelectionsV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { BotTemplateConnectionsSetup } from './BotTemplateSetup';

const modal = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: modal.show } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const empty: BotTemplateSetupSelectionsV1 = { software: [], accounts: [], mcpServers: [] };
const needs: BotTemplateContentV1['needs'] = {
    software: [],
    connectedAccounts: [{ key: 'issues', name: 'Issues', serviceId: 'happier.service.github/github', requirement: 'required',
        purpose: 'Read the chosen repository', skipConsequence: 'Cannot read issues' }],
    mcpServers: [{ key: 'search', name: 'Search', requirement: 'required', purpose: 'Search the private index', skipConsequence: 'Cannot search',
        definition: { name: 'Search', transport: 'stdio', stdio: { command: { kind: 'literal', value: 'search-mcp' }, args: [] }, env: { TOKEN: { kind: 'input', key: 'token' } },
            inputs: [{ key: 'token', label: 'Search token', purpose: 'Authenticate search', secret: true, required: true }] } }],
};

describe('template setup connection bindings', () => {
    it('uses the shared Connect sheet and retains recipient account and secret references only', async () => {
        // Modal presentation is the UI boundary; real Connect request construction remains exercised.
        modal.show.mockImplementation(config => {
            const props = config.props as { request: { service?: { kind?: string } }; onResult(result: unknown): void };
            queueMicrotask(() => props.onResult(props.request.service?.kind === 'key'
                ? { kind: 'selected', secretRef: 'recipient-key' }
                : { kind: 'selected', account: { service: { pluginId: 'happier.service.github', localId: 'github' }, accountId: 'recipient-account' } }));
            return 'connect';
        });
        let selected = empty;
        function Form() {
            const [value, setValue] = React.useState(empty);
            selected = value;
            return <BotTemplateConnectionsSetup needs={needs} value={value} onChange={setValue} scope={null} />;
        }
        const screen = await renderScreen(<Form />);
        expect(screen.getTextContent()).toContain('Read the chosen repository');
        await act(async () => { screen.pressByTestId('bot-template-connect-issues'); });
        await act(async () => { screen.pressByTestId('bot-template-mcp-search-token'); });
        expect(selected.accounts).toEqual([{ key: 'issues', selection: { action: 'connect',
            binding: { source: 'connected', selection: 'profile', profileId: 'recipient-account' } } }]);
        expect(selected.mcpServers).toEqual([{ key: 'search', selection: { action: 'bind', inputs: { token: { t: 'savedSecret', secretId: 'recipient-key' } } } }]);
        expect(JSON.stringify(selected)).not.toContain('Authenticate search');
        await screen.unmount();
    });

    it('preserves a previous binding when Connect is dismissed', async () => {
        modal.show.mockImplementation(config => { queueMicrotask(() => config.onRequestClose?.()); return 'connect'; });
        const onChange = vi.fn();
        const screen = await renderScreen(<BotTemplateConnectionsSetup needs={needs} value={empty} onChange={onChange} scope={null} />);
        await act(async () => { screen.pressByTestId('bot-template-connect-issues'); });
        expect(onChange).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('can select a required MCP server without filling its optional inputs', async () => {
        const optionalInputs: BotTemplateContentV1['needs'] = { software: [], connectedAccounts: [], mcpServers: [{
            ...needs.mcpServers[0]!, definition: { ...needs.mcpServers[0]!.definition,
                inputs: [{ key: 'token', label: 'Optional token', purpose: 'Authenticate if needed', secret: true, required: false }] },
        }] };
        let selected = empty;
        function Form() {
            const [value, setValue] = React.useState(empty);
            selected = value;
            return <BotTemplateConnectionsSetup needs={optionalInputs} value={value} onChange={setValue} scope={null} />;
        }
        const screen = await renderScreen(<Form />);
        await act(async () => { screen.pressByTestId('bot-template-mcp-search-use'); });
        expect(selected.mcpServers).toEqual([{ key: 'search', selection: { action: 'bind', inputs: {} } }]);
        await screen.unmount();
    });
});
