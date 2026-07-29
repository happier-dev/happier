import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const appearanceRuntime = vi.hoisted(() => {
    let colorScheme: 'light' | 'dark' = 'light';
    const listeners = new Set<() => void>();

    return {
        getSnapshot: () => colorScheme,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setColorScheme: (nextColorScheme: 'light' | 'dark') => {
            colorScheme = nextColorScheme;
            for (const listener of listeners) {
                listener();
            }
        },
    };
});

vi.mock('react-native-svg', () => ({
    SvgXml: (props: any) => React.createElement('SvgXml', props),
}));

vi.mock('@/components/ui/media/SafeExpoImage', () => ({
    SafeExpoImage: (props: any) => React.createElement('SafeExpoImage', props),
}));

vi.mock('react-native-unistyles', async () => {
    const [{ createUnistylesMock }, ReactModule] = await Promise.all([
        import('@/dev/testkit/mocks/unistyles'),
        import('react'),
    ]);
    const lightRuntime = await createUnistylesMock({
        theme: {
            colors: {
                text: {
                    primary: '#101010',
                },
            },
        },
    });
    const darkRuntime = await createUnistylesMock({
        theme: {
            colors: {
                text: {
                    primary: '#efefef',
                },
            },
        },
        rt: {
            themeName: 'dark',
            colorScheme: 'dark',
        },
    });

    return {
        ...lightRuntime,
        useUnistyles: () => {
            const tracksColorScheme = ReactModule.useRef(false);
            ReactModule.useSyncExternalStore(
                ReactModule.useCallback(
                    (listener) => appearanceRuntime.subscribe(() => {
                        if (tracksColorScheme.current) {
                            listener();
                        }
                    }),
                    [],
                ),
                appearanceRuntime.getSnapshot,
                appearanceRuntime.getSnapshot,
            );
            const runtime = appearanceRuntime.getSnapshot() === 'dark'
                ? darkRuntime.useUnistyles()
                : lightRuntime.useUnistyles();
            return {
                ...runtime,
                rt: new Proxy(runtime.rt, {
                    get(target, property, receiver) {
                        if (property === 'colorScheme') {
                            tracksColorScheme.current = true;
                        }
                        return Reflect.get(target, property, receiver);
                    },
                }),
            };
        },
    };
});

const catalogSpies = vi.hoisted(() => ({
    getAgentIconSource: vi.fn((agentId: string) => agentId === 'image' ? { uri: 'agent.png' } : null),
    getAgentIconSvgXml: vi.fn((agentId: string, theme: { colors: { text: { primary: string } } }) => agentId === 'svg'
        ? `<svg fill="${theme.colors.text.primary}" stroke="#222222"><path fill="#333333" stroke="none" /></svg>`
        : null),
    getAgentIconTintColor: vi.fn(() => '#444444'),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSource: catalogSpies.getAgentIconSource,
    getAgentIconSvgXml: catalogSpies.getAgentIconSvgXml,
    getAgentIconTintColor: catalogSpies.getAgentIconTintColor,
}));

describe('AgentIcon color override', () => {
    afterEach(() => {
        standardCleanup();
        appearanceRuntime.setColorScheme('light');
        catalogSpies.getAgentIconSource.mockClear();
        catalogSpies.getAgentIconSvgXml.mockClear();
        catalogSpies.getAgentIconTintColor.mockClear();
    });

    it('applies the explicit color to svg fills and strokes', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <AgentIcon
                agentId="svg"
                size={16}
                color="#777777"
            />,
        );

        const svg = screen.findAllByType('SvgXml' as never)[0];
        expect(svg?.props.xml).toContain('fill="#777777"');
        expect(svg?.props.xml).toContain('stroke="#777777"');
        expect(svg?.props.xml).toContain('stroke="none"');
    });

    it('uses the explicit color as the image tint', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <AgentIcon
                agentId="image"
                size={16}
                color="#777777"
            />,
        );

        expect(screen.findAllByType('SafeExpoImage' as never)[0]?.props.tintColor).toBe('#777777');
    });

    it('refreshes an already-mounted theme-derived svg on the first appearance transition', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <AgentIcon
                agentId="svg"
                size={16}
            />,
        );
        const initialSvg = screen.findAllByType('SvgXml' as never)[0];
        expect(initialSvg?.props.xml).toContain('fill="#101010"');

        await act(async () => {
            appearanceRuntime.setColorScheme('dark');
        });

        const updatedSvgs = screen.findAllByType('SvgXml' as never);
        expect(updatedSvgs).toHaveLength(1);
        expect(updatedSvgs[0]).toBe(initialSvg);
        expect(updatedSvgs[0]?.props.xml).toContain('fill="#efefef"');
    });

    it('does not recompute an unchanged icon on an equivalent parent render', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <>
                <AgentIcon
                    agentId="svg"
                    size={16}
                    color="#777777"
                />
                <HarnessTick value={0} />
            </>,
        );
        expect(catalogSpies.getAgentIconSvgXml).toHaveBeenCalledTimes(1);

        await screen.update(
            <>
                <AgentIcon
                    agentId="svg"
                    size={16}
                    color="#777777"
                />
                <HarnessTick value={1} />
            </>,
        );

        expect(catalogSpies.getAgentIconSvgXml).toHaveBeenCalledTimes(1);
    });
});

function HarnessTick(_props: { value: number }) {
    return null;
}
