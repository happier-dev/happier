import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PublicActionInputById } from '@happier-dev/protocol';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { buildWidgetCandidateSetup } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { WidgetSetupStep } from './WidgetSetupStep';
import { WidgetSetupFieldRow } from './WidgetSetupFieldRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// Only the Action network boundary is replaced; draft binding and options demand remain real.
const discovery = vi.hoisted(() => ({ requests: [] as PublicActionInputById['action.options.resolve'][] }));
vi.mock('@/sync/domains/workflows/callWorkflowAction', () => ({
    callWorkflowAction: async (args: { input: PublicActionInputById['action.options.resolve']; parseResult(value: unknown): unknown }) => {
        discovery.requests.push(args.input);
        const selected = args.input.consumer?.kind === 'widget' ? args.input.consumer.selectedSession?.sessionId : undefined;
        return args.parseResult({ actionId: null, fieldPath: args.input.fieldPath ?? null, optionsSourceId: args.input.optionsSourceId ?? null,
            options: [{ value: 'choice', label: `${selected ?? 'ambient'}:${args.input.draftInput?.filter ?? 'none'}` }] });
    },
}));
afterEach(() => { standardCleanup(); discovery.requests = []; });

const scope = { serverId: 'setup-home', accountId: 'me', owner: { kind: 'companion' as const, sessionId: 'A' } };
const candidate: WidgetCandidate = { key: 'acme.options/checks', title: 'Checks', pluginName: 'Options', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'session', sessionInputPath: 'session',
    sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
    surface: { pluginId: 'acme.options', localId: 'checks' }, inputs: { fields: [
        { path: 'session', title: 'Session', widget: 'json', required: true },
        { path: 'filter', title: 'Filter', widget: 'text' },
        { path: 'result', title: 'Result', widget: 'select', required: true, optionsSourceId: 'sessions' },
    ] } };

describe('WidgetSetupStep discovery', () => {
    it('does not write when a ready size-only setup is cancelled', async () => {
        const submit = vi.fn(async () => ({ ok: true as const }));
        const cancel = vi.fn();
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit });
        expect(setup.resolve(setup.initial).status).toBe('ready');
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false}
            onCancel={cancel} onDone={() => {}} testID="size-only" />);
        await screen.pressByTestIdAsync('size-only.size.large');
        await screen.pressByTestIdAsync('size-only.cancel');
        expect(cancel).toHaveBeenCalledOnce();
        expect(submit).not.toHaveBeenCalled();
    });
    it('previews the chosen declared size and submits it together with the input bindings', async () => {
        const sized: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'text' as const, required: true }] },
            sizeDeclaration: { sizes: ['large', 'small', 'medium'], defaultSize: 'medium' } };
        const previews: unknown[] = [];
        const submit = vi.fn(async () => ({ ok: true as const }));
        const setup = buildWidgetCandidateSetup({ candidate: sized, scope: { ...scope, owner: { kind: 'home' } },
            audience: 'personal', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit,
            renderPreview: ({ draft }) => { previews.push(draft); return null; } });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false}
            onCancel={() => {}} onDone={() => {}} testID="size-setup" />);
        expect(screen.findByTestId('size-setup.size.small')).not.toBeNull();
        await screen.pressByTestIdAsync('size-setup.size.large');
        await act(async () => { screen.changeTextByTestId('size-setup.field.filter.input', 'open'); });
        await screen.pressByTestIdAsync('size-setup.submit');
        expect(previews.at(-1)).toEqual({ size: 'large', bindings: { filter: { kind: 'value', value: 'open' } } });
        expect(submit).toHaveBeenCalledWith({ size: 'large', bindings: { filter: { kind: 'value', value: 'open' } } });
    });

    it('accepts a typed JSON literal without discovery through the public field parser and binder', async () => {
        const literal: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'json', required: true,
                inputType: { pluginId: 'acme.options', localId: 'filter' } }] },
            inputSchema: { type: 'object', properties: { filter: { type: 'object', properties: { branch: { type: 'string' } },
                required: ['branch'], additionalProperties: false } }, required: ['filter'], additionalProperties: false } };
        const submit = vi.fn(async () => ({ ok: true as const }));
        const setup = buildWidgetCandidateSetup({ candidate: literal, scope, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onCancel={() => {}} onDone={() => {}} testID="literal" />);
        expect(screen.findByTestId('literal.submit')!.props.disabled).toBe(true);
        expect(screen.findByTestId('literal.field.filter.input')).not.toBeNull();
        await act(async () => { screen.changeTextByTestId('literal.field.filter.input', '{"branch":"main"}'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('literal.submit')!.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('literal.submit');
        expect(submit).toHaveBeenCalledWith({ bindings: { filter: { kind: 'value', value: { branch: 'main' } } } });
        expect(discovery.requests).toHaveLength(0);
    });

    it('discovers against the current pinned Session and refreshes dependent options when the draft changes', async () => {
        const setup = buildWidgetCandidateSetup({ candidate, scope, audience: 'personal', context: {
            session: { ref: { serverId: scope.serverId, sessionId: 'A' }, label: 'A' },
        }, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId} sessionId="A"
            onCancel={() => {}} onDone={() => {}} testID="setup" />);
        await flushHookEffects({ cycles: 4 });
        const change = async (path: string, value: Parameters<React.ComponentProps<typeof WidgetSetupFieldRow>['onChange']>[0]) => {
            await act(async () => { screen.findAllByType(WidgetSetupFieldRow).find(row => row.props.entry.field.path === path)!.props.onChange(value); });
            await flushHookEffects({ cycles: 4 });
        };
        await change('session', { kind: 'pin', value: { serverId: scope.serverId, sessionId: 'B' } });
        await change('filter', { kind: 'pin', value: 'open' });
        const request = discovery.requests.filter(request => request.fieldPath === 'result').at(-1)!;
        expect(request.consumer).toMatchObject({ kind: 'widget', selectedSession: { serverId: scope.serverId, sessionId: 'B' } });
        expect(request.draftInput).toMatchObject({ session: { serverId: scope.serverId, sessionId: 'B' }, filter: 'open' });
        const options = screen.findAllByType(DropdownMenu).find(row => row.props.testID === 'setup.field.result')!.props.items;
        expect(options[0]?.title).toBe('B:open');
    });

    it('discovers connection-only options for a personal field without making a shared viewer field selectable', async () => {
        const personal = { ...candidate, target: 'app' as const, sessionInputPath: undefined, inputs: { fields: [
            { path: 'connection', title: 'Connection', widget: 'select' as const, required: true, connectedAccountOptions: true as const },
        ] }, connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics', consumer: { pluginId: 'acme.options', localId: 'checks' } }] };
        const setup = buildWidgetCandidateSetup({ candidate: personal, scope, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onCancel={() => {}} onDone={() => {}} testID="connection" />);
        await flushHookEffects({ cycles: 4 });
        expect(discovery.requests.some(request => request.fieldPath === 'connection')).toBe(true);
        expect(screen.findAllByType(DropdownMenu).find(row => row.props.testID === 'connection.field.connection')!.props.items).toHaveLength(1);
        expect(buildWidgetCandidateSetup({ candidate: personal, scope: { ...scope, owner: { kind: 'sessionBoard', sessionId: 'A' } },
            audience: 'shared', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) }).fields[0]?.viewer)
            .toEqual({ purpose: 'metrics' });
    });
});

describe('WidgetSetupStep on a phone', () => {
    it('keeps a visible dismiss in Edit inputs: the header caret closes the sheet when there is no step to go back to', async () => {
        const close = vi.fn();
        const setup = buildWidgetCandidateSetup({ candidate, scope, audience: 'personal', context: {
            session: { ref: { serverId: scope.serverId, sessionId: 'A' }, label: 'A' },
        }, mode: { kind: 'edit', instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: candidate.surface! }, bindings: {} } },
        submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone serverId={scope.serverId}
            onCancel={() => {}} onClose={close} onDone={() => {}} testID="edit" />);
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('edit.back')).toBeNull();
        await screen.pressByTestIdAsync('edit.close');
        expect(close).toHaveBeenCalledTimes(1);
    });
});
