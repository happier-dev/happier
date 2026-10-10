import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ProjectsTree } from './ProjectsTree';
import { buildProjectsTreeRows } from './projectsTreeRows';
import { t } from '@/text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({});
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const rows = buildProjectsTreeRows({
    projects: [
        { key: 'plugins', name: 'happier-plugins', checkouts: [
            { refId: 'p1', machineId: 'devbox', machineName: 'devbox', label: 'main', path: '~/src/plugins', attention: null },
            { refId: 'p2', machineId: 'devbox', machineName: 'devbox', label: 'pi-agent', path: '~/src/plugins-wt/pi-agent', attention: 'working' },
        ] },
    ],
    openRefId: null,
    expandedKeys: new Set(['plugins']),
});

describe('ProjectsTree (lab p-projects TREE/HIDDEN)', () => {
    it('discloses a Project from its row and opens an exact checkout from a leaf', async () => {
        const onToggle = vi.fn();
        const onOpenRef = vi.fn();
        const screen = await renderScreen(<ProjectsTree rows={rows} onToggle={onToggle} onOpenRef={onOpenRef} />);
        await screen.pressByTestIdAsync('projects-tree-row-plugins');
        expect(onToggle).toHaveBeenCalledWith('plugins');
        expect(onOpenRef).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('projects-tree-row-plugins/p2');
        // The leaf opens that exact checkout (its ref, and the address that disambiguates a shared id).
        expect(onOpenRef.mock.calls[0]?.[0]).toBe('p2');
    });

    it('is one keyboard tree: roving stop, arrows move, Space/Right disclose, Enter opens a leaf', async () => {
        const onToggle = vi.fn();
        const onOpenRef = vi.fn();
        const screen = await renderScreen(<ProjectsTree rows={rows} onToggle={onToggle} onOpenRef={onOpenRef} />);
        const item = (key: string) => screen.findAll((node) => node.props?.testID === `projects-tree-row-${key}`
            && typeof node.props?.onKeyDown === 'function')[0]!;
        const press = async (key: string, keyboardKey: string) => {
            await act(async () => { item(key).props.onKeyDown({ key: keyboardKey, nativeEvent: { key: keyboardKey }, preventDefault: () => {} }); });
        };
        // One tab stop, on the first row; tree semantics carry level and expanded state.
        expect(item('plugins').props.webTabIndex).toBe(0);
        expect(item('plugins/p1').props.webTabIndex).toBe(-1);
        expect(item('plugins').props.accessibilityLevel).toBe(1);
        expect(item('plugins/p1').props.accessibilityLevel).toBe(2);
        expect(item('plugins').props.accessibilityExpanded).toBe(true);

        await press('plugins', 'ArrowDown');
        expect(item('plugins/p1').props.webTabIndex).toBe(0);
        await press('plugins/p1', 'Enter');
        expect(onOpenRef.mock.calls[0]?.[0]).toBe('p1');

        // Space on the open Project closes it in place; Enter on a leaf never toggles.
        await press('plugins', ' ');
        expect(onToggle).toHaveBeenCalledWith('plugins');
        expect(onToggle).toHaveBeenCalledTimes(1);
        await press('plugins/p2', 'End');
        await press('plugins/p2', 'Home');
        expect(item('plugins').props.webTabIndex).toBe(0);
    });

    it('keeps focus in the tree when the focused checkout disappears (its Project closes or hides)', async () => {
        const screen = await renderScreen(<ProjectsTree rows={rows} onToggle={() => {}} onOpenRef={() => {}} />);
        const item = (key: string) => screen.findAll((node) => node.props?.testID === `projects-tree-row-${key}`
            && typeof node.props?.onKeyDown === 'function')[0];
        await act(async () => { item('plugins/p2')!.props.onFocus(); });
        expect(item('plugins/p2')!.props.webTabIndex).toBe(0);
        const collapsed = buildProjectsTreeRows({ projects: [{ key: 'plugins', name: 'happier-plugins', checkouts: [
            { refId: 'p1', machineId: 'devbox', machineName: 'devbox', label: 'main', path: '~/src/plugins', attention: null },
            { refId: 'p2', machineId: 'devbox', machineName: 'devbox', label: 'pi-agent', path: '~/x', attention: null },
        ] }], openRefId: null, expandedKeys: new Set(), collapsedKeys: new Set(['plugins']) });
        await act(async () => { screen.tree.update(<ProjectsTree rows={collapsed} onToggle={() => {}} onOpenRef={() => {}} />); });
        // The roving stop repairs to the nearest visible ancestor, never off the tree.
        expect(item('plugins')!.props.webTabIndex).toBe(0);
    });

    it('says once, on the row, that a Project arrived from a session (lab p-projects AUTO)', async () => {
        const fresh = buildProjectsTreeRows({
            projects: [
                { key: 'pricing', name: 'pricing-api', newFromSession: true, checkouts: [
                    { refId: 'n1', machineId: 'mbp', machineName: 'MacBook Pro', label: 'main', path: '~/code/pricing-api', attention: 'working' },
                ] },
                { key: 'web', name: 'website', checkouts: [
                    { refId: 'w1', machineId: 'mbp', machineName: 'MacBook Pro', label: 'main', path: '~/code/website', attention: null },
                ] },
            ],
            openRefId: null,
            expandedKeys: new Set(),
        });
        const screen = await renderScreen(<ProjectsTree rows={fresh} onToggle={() => {}} onOpenRef={() => {}} />);
        const line = t('projects.identity.newFromSession');
        expect(screen.getTextContent().split(line).length - 1).toBe(1);
        expect(screen.getTextContent()).toContain(`${line} · MacBook Pro`);
    });

    it('collects hidden Projects at the end and shows one back', async () => {
        const onShow = vi.fn();
        const screen = await renderScreen(
            <ProjectsTree
                rows={rows}
                onToggle={() => {}}
                onOpenRef={() => {}}
                hidden={{ items: [{ key: 'scratch', title: 'scratch-2024', subtitle: 'MacBook Pro · ~/scratch-2024' }], open: true, onToggle: () => {}, onShow }}
            />,
        );
        await screen.pressByTestIdAsync('projects-tree-show-scratch');
        expect(onShow).toHaveBeenCalledWith('scratch');
    });
});
