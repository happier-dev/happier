import * as React from 'react';
import { GestureDetector } from 'react-native-gesture-handler';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Portal placement is a platform boundary; lens state, command admission and row selection stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
const serveLensHome = () => serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-lens.test', accountId: 'account-a' }],
    route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
// Restore the real Home before runtime imports; cold graph transformation is collection work.
const storage = installLocalStorageMock();
afterAll(() => storage.restore());
home = await serveLensHome();
const { useCurrentUiContextComposedCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
const { useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { ScrubLens } = await import('./UsageScrubLens');
const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { Popover } = await import('@/components/ui/popover');
await home.dispose();
home = undefined;

afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
});

it('keeps declarations and current-context publications fixed across new vitals buckets while reading their latest exact values', async () => {
    home = await serveLensHome();
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    let append: () => void = () => {};
    let rename: () => void = () => {};
    let declarations = 0;
    let publications = 0;
    function Observe() {
        const commands = useCurrentUiContextComposedCommands();
        const reader = useOptionalCurrentUiContextReader();
        React.useLayoutEffect(() => { declarations++; }, [commands]);
        React.useEffect(() => reader?.subscribe(() => { publications++; }), [reader]);
        return null;
    }
    function LiveChart() {
        const [values, setValues] = React.useState(['69.8811%']);
        const [label, setLabel] = React.useState('CPU');
        append = () => setValues(previous => [...previous, `${previous.length}.12345%`]);
        rename = () => setLabel('Memory');
        return <ScrubLens label={label} layout={{ centers: values.map((_, index) => index * 20) }} accentColor="#123456"
            resolveContent={index => ({ title: `Sample ${index}`, rows: [{ label: 'Mean', value: values[index]! }] })} />;
    }
    const screen = await renderMountedCurrentUiContext(<><Observe /><LiveChart /></>);
    const port = readCurrentUiContextActionReader({ surface: 'agent' })!;
    const snapshot = port.readCurrentUiContext()!;
    declarations = 0;
    publications = 0;
    for (let index = 0; index < 3; index++) await act(async () => append());
    expect(declarations, 'new samples must not change the command inventory').toBe(0);
    expect(publications, 'new samples must not publish the UI context').toBe(0);
    expect(port.readCurrentUiContext()).toBe(snapshot);
    const command = snapshot.commands.find(entry => entry.title === `CPU: ${t('usage.board.charts.commandValues')}`)!;
    expect(command).toBeDefined();
    const executor = createDefaultActionExecutor();
    const result = await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' });
    expect(result).toMatchObject({ ok: true, result: { buckets: [
        { index: 0, rows: [{ value: '69.8811%' }] }, { index: 1, rows: [{ value: '1.12345%' }] },
        { index: 2, rows: [{ value: '2.12345%' }] }, { index: 3, rows: [{ value: '3.12345%' }] },
    ] } });
    await act(async () => rename());
    expect(declarations, 'a real chart identity change publishes once').toBe(1);
    expect(port.readCurrentUiContext()).not.toBe(snapshot);
    expect(publications, 'a real chart identity change publishes once').toBe(1);
    await screen.unmount();
});

it('reveals the same bucket, chooses its rows and dismisses through mounted agent commands and gestures', async () => {
    // Global test isolation clears device storage after collection; restore fresh actual credentials.
    home = await serveLensHome();
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    let contentReads = 0;
    const contentResolvers: WeakRef<object>[] = [];
    function Fixture() {
        const [selected, setSelected] = React.useState(false);
        const resolveContent = (index: number) => {
            contentReads += 1;
            return index === 1 ? null : {
                title: index === 0 ? 'Nov 6' : 'Nov 7', total: index === 0 ? '12M' : '19M',
                rows: [{ id: 'source', label: 'Main source', value: selected ? 'Selected' : 'Available', selected,
                    pressLabel: 'Choose main source', onPress: () => setSelected(value => !value) }],
            };
        };
        contentResolvers.push(new WeakRef(resolveContent));
        return <ScrubLens testID="usage.scrub" layout={{ centers: [20, 80, 140] }} accentColor="#123456"
            resolveContent={resolveContent} />;
    }
    const screen = await renderMountedCurrentUiContext(<Fixture />);
    const executor = createDefaultActionExecutor();
    const read = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!;
    const invoke = async (title: string, input?: { bucket?: number; mode?: string; row?: string }) => {
        const command = read().commands.find(candidate => candidate.title === title);
        expect(command).toBeDefined();
        await act(async () => {
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: command!.id, input }, { surface: 'agent' }))
                .toMatchObject({ ok: true });
        });
    };
    const reveal = read().commands.find(command => command.title === t('usage.board.charts.commandValues'));
    expect(reveal).toBeDefined();
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(0);
    await act(async () => {
        expect(await executor.execute('ui.current_context.command.invoke', {
            commandId: reveal!.id, input: { bucket: 1, mode: 'select' },
        }, { surface: 'agent' })).toMatchObject({ ok: false });
    });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(0);
    await act(async () => {
        expect(await executor.execute('ui.current_context.command.invoke', {
            commandId: reveal!.id, input: { bucket: 2, mode: 'select' },
        }, { surface: 'agent' })).toMatchObject({ ok: true, result: { buckets: [
            { index: 2, title: 'Nov 7', total: '19M', rows: [{ id: 'source', value: 'Available', selectable: true }] },
        ] } });
    });
    expect(screen.getTextContent()).toContain('Nov 7');
    expect(screen.getTextContent()).toContain('19M');
    expect(screen.findHostByTestId('usage.scrub-lens-row-source')?.props.accessibilityLabel).toBe('Choose main source');
    await invoke(t('usage.board.charts.commandChoose'), { row: 'source' });
    expect(screen.findHostByTestId('usage.scrub-lens-row-source')?.findAll(node => node.children.includes('Selected')).length).toBeGreaterThan(0);
    await screen.pressByTestIdAsync('usage.scrub-lens-row-source');
    expect(screen.findHostByTestId('usage.scrub-lens-row-source')?.findAll(node => node.children.includes('Available')).length).toBeGreaterThan(0);
    await act(async () => { screen.findByType(Popover).props.onRequestClose(); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(0);

    // The canonical gesture boundary records the composed hover / pan / tap callbacks.
    const gesture: { gestures: [{ __handlers: Record<string, (event?: { x: number }) => void> },
        { gestures: [{ __handlers: Record<string, (event?: { x: number }) => void> },
            { __handlers: Record<string, (event?: { x: number }) => void> }] }] } = screen.findByType(GestureDetector).props.gesture;
    contentReads = 0;
    await act(async () => { gesture.gestures[1].gestures[1].__handlers.onEnd!({ x: 20 }); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(1);
    expect(screen.getTextContent()).toContain('Nov 6');
    expect(screen.getTextContent()).toContain('12M');
    await act(async () => { gesture.gestures[1].gestures[1].__handlers.onEnd!({ x: 20 }); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(0);
    await act(async () => { gesture.gestures[1].gestures[1].__handlers.onEnd!({ x: 20 }); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(1);
    const close = read().commands.find(command => command.title === t('common.close'));
    expect(close).toBeDefined();
    await invoke(close!.title);
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(0);
    await act(async () => { gesture.gestures[0].__handlers.onBegin!({ x: 140 }); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(1);
    expect(screen.getTextContent()).toContain('Nov 7');
    expect(screen.findAllHostsByTestId('usage.scrub-lens-row-source')).toHaveLength(0);
    await act(async () => {
        const choose = read().commands.find(command => command.title === t('usage.board.charts.commandChoose'))!;
        expect(await executor.execute('ui.current_context.command.invoke', {
            commandId: choose.id, input: { row: 'source' },
        }, { surface: 'agent' })).toMatchObject({ ok: false });
    });
    await act(async () => { gesture.gestures[0].__handlers.onFinalize!(); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(0);
    await act(async () => { gesture.gestures[1].gestures[0].__handlers.onStart!({ x: 140 }); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(1);
    await act(async () => { gesture.gestures[1].gestures[0].__handlers.onFinalize!(); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(0);
    // Pointer movement and held-state changes reuse the same resolved series data.
    expect(contentReads).toBe(0);
    // The UI has the same mounted authority as its commands; no direct gesture fallback survives retirement.
    await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
    await act(async () => { gesture.gestures[1].gestures[1].__handlers.onEnd!({ x: 140 }); });
    expect(screen.findAllHostsByTestId('usage.scrub-lens')).toHaveLength(0);
    await screen.unmount();
    // Gesture hosts can retain their callbacks after the lens unmounts.
    // Those callbacks must release the chart data closed over by its resolver.
    const { Session } = await import('node:inspector');
    const inspector = new Session();
    inspector.connect();
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
        expect(contentResolvers.length).toBeGreaterThan(0);
        expect(contentResolvers.filter(resolver => resolver.deref() !== undefined).length,
            'retained native gesture callbacks release every retired content resolver').toBe(0);
        expect(gesture.gestures[0].__handlers.onBegin).toBeTypeOf('function');
    } finally { inspector.disconnect(); }
});
