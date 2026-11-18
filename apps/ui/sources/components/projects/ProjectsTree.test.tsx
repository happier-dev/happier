import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { useProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

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

afterEach(() => standardCleanup());

describe('ProjectsTree section render locality', () => {
    async function mountCensus() {
        storage.setState({ sessions: {}, sessionListRowsByServerId: {}, machines: {}, machineListByServerId: {},
            profileScope: { serverId: 'qp2-home', accountId: 'qp2-account' },
            sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
        });
        const refs: readonly WorkspaceRefV1[] = Array.from({ length: 151 }, (_, index) => ({
            id: `checkout-${index}`, serverId: 'qp2-home', machineId: 'machine', rootPath: `/repo-${index}`, createdAtMs: 1,
        }));
        const projects = Array.from({ length: 150 }, (_, index) => ({
            key: `project-${index}`, name: `Project ${index}`,
            checkouts: (index === 0 ? [refs[0]!, refs[150]!] : [refs[index]!]).map(ref => ({
                refId: ref.id, workspaceAddress: { serverId: ref.serverId!, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath },
                machineId: ref.machineId, machineName: 'Machine', label: 'main', path: ref.rootPath, attention: null,
            })),
        }));
        const renders = new Map<string, number>();
        const renderRowMenu = (row: { key: string; level: number }) => {
            if (row.level === 0) renders.set(row.key, (renders.get(row.key) ?? 0) + 1);
            return null;
        };
        const onToggle = () => {};
        const onOpenRef = () => {};
        function Census({ expandedKeys, openRefId = null, onOpen = onOpenRef }: {
            expandedKeys: ReadonlySet<string>; openRefId?: string | null; onOpen?: typeof onOpenRef;
        }) {
            const source = useProjectsTreeCheckoutFactsSource(refs);
            const treeRows = React.useMemo(() => buildProjectsTreeRows({ projects, openRefId, expandedKeys }), [expandedKeys, openRefId]);
            // A fresh input carrier forces a tree render while the Project inputs are unchanged.
            return <ProjectsTree rows={treeRows} live={{ source, projects, openRefId, expandedKeys }}
                onToggle={onToggle} onOpenRef={onOpen} renderRowMenu={renderRowMenu} />;
        }
        const expandedKeys = new Set<string>();
        const screen = await renderScreen(<Census expandedKeys={expandedKeys} />);
        expect(renders.size).toBe(150);
        renders.clear();
        return { screen, renders, Census, expandedKeys };
    }

    it('keeps unaffected sections quiet through tree renders, another Project expansion and keyboard focus', async () => {
        const { screen, renders, Census, expandedKeys } = await mountCensus();
        await screen.update(<Census expandedKeys={expandedKeys} />);
        expect([...renders]).toEqual([]);
        await screen.update(<Census expandedKeys={new Set(['project-0'])} />);
        expect([...renders]).toEqual([['project-0', 1]]);
        renders.clear();
        const item = (key: string) => screen.findAll(node => node.props?.testID === `projects-tree-row-${key}:treeitem`
            && typeof node.props?.onKeyDown === 'function')[0]!;
        await act(async () => item('project-0').props.onKeyDown({ key: 'End', preventDefault() {} }));
        expect([...renders.keys()].sort()).toEqual(['project-0', 'project-149']);
        expect(item('project-149').props.tabIndex).toBe(0);
        expect(item('project-0').props.tabIndex).toBe(-1);
    });

    it('updates only old/new selected Projects and the ones above them, and dispatches the latest open handler without repainting sections', async () => {
        const { screen, renders, Census, expandedKeys } = await mountCensus();
        // The Project above the open row repaints too: its last row's list-row rule steps aside for the open row's fill.
        await screen.update(<Census expandedKeys={expandedKeys} openRefId="checkout-27" />);
        expect([...renders.keys()].sort()).toEqual(['project-26', 'project-27']);
        renders.clear();
        await screen.update(<Census expandedKeys={expandedKeys} openRefId="checkout-28" />);
        expect([...renders.keys()].sort()).toEqual(['project-26', 'project-27', 'project-28']);
        renders.clear();
        const onOpen = vi.fn();
        await screen.update(<Census expandedKeys={expandedKeys} openRefId="checkout-28" onOpen={onOpen} />);
        expect([...renders]).toEqual([]);
        await screen.pressByTestIdAsync('projects-tree-row-project-28');
        expect(onOpen.mock.calls[0]?.[0]).toBe('checkout-28');
    });

    it('renders exactly one section when one checkout fact changes', async () => {
        const { screen, renders } = await mountCensus();
        await act(async () => {
            const row = createSessionListRenderableSessionFixture({ id: 'qp2-session', active: true, activeAt: Date.now(),
                thinking: true, thinkingAt: Date.now(), metadata: { machineId: 'machine', path: '/repo-27' } });
            storage.setState({ sessionListRowsByServerId: { 'qp2-home': { [row.id]: row } },
                sessionListRenderableDelta: { revision: 1, changedSessionIds: [row.id], removedSessionIds: [], rebuiltSessionListIndex: false } });
        });
        expect([...renders]).toEqual([['project-27', 1]]);
        expect(screen.findByTestId('projects-tree-row-project-27')).not.toBeNull();
    });
});

describe('ProjectsTree (lab p-projects TREE/HIDDEN)', () => {
    it('keeps described, saved and hidden navigation rows compact with their independent trailing controls', async () => {
        const { Item } = await import('@/components/ui/lists/Item');
        const { Pressable, Text } = await import('react-native');
        const open = vi.fn();
        const menu = vi.fn();
        const screen = await renderScreen(<ProjectsTree rows={rows} onToggle={() => {}} onOpenRef={open}
            renderRowMenu={row => <Pressable testID={`menu-${row.key}`} onPress={menu}><Text>Menu</Text></Pressable>}
            saved={{ items: [{ key: 'saved', title: 'Saved source', subtitle: 'acme/repository' }], onOpen: () => {} }}
            hidden={{ items: [{ key: 'hidden', title: 'Hidden checkout', subtitle: '~/src/hidden', refId: 'hidden-ref' }], open: true, onToggle: () => {}, onShow: () => {} }} />);
        const items = screen.findAllByType(Item).filter(node => node.props.testID?.startsWith('projects-tree-'));
        expect(items.length).toBeGreaterThan(rows.length);
        expect(items.every(node => node.props.rowRole === 'item' && node.props.titleLines === 1)).toBe(true);
        await screen.pressByTestIdAsync('menu-plugins/p1');
        expect(menu).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('projects-tree-row-plugins/p1');
        expect(open.mock.calls[0]?.[0]).toBe('p1');
    });

    it('opens a Project from its own row, discloses it only from its trailing chevron, and opens an exact checkout from a leaf', async () => {
        const onToggle = vi.fn();
        const onOpenRef = vi.fn();
        const screen = await renderScreen(<ProjectsTree rows={rows} onToggle={onToggle} onOpenRef={onOpenRef} />);
        // The Project row is the Project: it opens on its most recently opened checkout (none opened yet: the first).
        await screen.pressByTestIdAsync('projects-tree-row-plugins');
        expect(onOpenRef.mock.calls[0]?.[0]).toBe('p1');
        expect(onToggle).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('projects-tree-row-plugins:disclosure');
        expect(onToggle).toHaveBeenCalledWith('plugins');
        expect(onOpenRef).toHaveBeenCalledTimes(1);
        onOpenRef.mockClear();
        await screen.pressByTestIdAsync('projects-tree-row-plugins/p2');
        // The leaf opens that exact checkout (its ref, and the address that disambiguates a shared id).
        expect(onOpenRef.mock.calls[0]?.[0]).toBe('p2');
    });

    it('spends no disclosure column: every mark keeps the leading edge and only a Project with checkouts has a chevron', async () => {
        const { Item } = await import('@/components/ui/lists/Item');
        const { resolveHappierCollectionTreeChildIndentPx, HappierTreeDisclosure } = await import('@happier-dev/plugin-ui/presentation');
        const single = buildProjectsTreeRows({ projects: [{ key: 'solo', name: 'solo', checkouts: [
            { refId: 's1', machineId: 'devbox', machineName: 'devbox', label: 'main', path: '~/solo', attention: null },
        ] }], openRefId: null, expandedKeys: new Set() });
        const screen = await renderScreen(<ProjectsTree rows={[...rows, ...single]} onToggle={() => {}} onOpenRef={() => {}}
            hidden={{ items: [{ key: 'h', title: 'Hidden', subtitle: '~/h', refId: 'h-ref' }], open: true, onToggle: () => {}, onShow: () => {} }} />);
        const chevrons = screen.findAllByType(HappierTreeDisclosure).map(node => node.props.testID ?? null);
        // One chevron per expandable row (the Project, and the Hidden group), each its own trailing target; no leaf spacer.
        expect(chevrons.sort()).toEqual(['projects-tree-hidden:disclosure', 'projects-tree-row-plugins:disclosure']);
        const items = screen.findAllByType(Item).filter(node => /^projects-tree-(row|hidden)/.test(node.props.testID ?? ''));
        // Leading boxes hold only the row's own mark, at rest and under hover.
        expect(items.every(node => node.props.leftElementWhenHovered === undefined)).toBe(true);
        const padding = (testID: string) => Object.assign({}, ...[items.find(node => node.props.testID === testID)!.props.style].flat(Infinity).filter(Boolean)).paddingLeft;
        // A checkout starts its mark where its Project's mark ends; Projects with and without checkouts align.
        expect(padding('projects-tree-row-plugins/p1') - padding('projects-tree-row-plugins')).toBe(resolveHappierCollectionTreeChildIndentPx());
        expect(padding('projects-tree-row-solo')).toBe(padding('projects-tree-row-plugins'));
        expect(padding('projects-tree-hidden-h')).toBe(padding('projects-tree-row-plugins'));
    });

    it('draws an Environment row on one line with its end: the one Environment state mark in trouble, else the quiet fact (lab rdProj)', async () => {
        const env = (environmentId: string, title: string, fact: string, state: Readonly<{ tone: 'danger' | 'warning' | null; text: string }> | null) => ({
            serverId: 'home', projectSourceId: 'src', environmentId, title, titleQualifier: null, fact, state, platform: null,
            attention: state ? 'needs-you' as const : null });
        const billing = buildProjectsTreeRows({ projects: [{ key: 'billing', name: 'billing', checkouts: [
            { refId: 'b1', machineId: 'devbox', machineName: 'devbox', label: 'main', path: '~/billing', attention: null },
        ], environments: [env('prod', 'Production', 'v1.42', null), env('stg', 'Staging', '2h', { tone: 'danger', text: 'Deploy failed' })] }],
        openRefId: null, expandedKeys: new Set(['billing']) });
        const screen = await renderScreen(<ProjectsTree rows={billing} onToggle={() => {}} onOpenRef={() => {}} />);
        // Every string drawn under the row end's node.
        const text = (testID: string) => screen.findAll(node => node.props?.testID === testID).slice(0, 1)
            .flatMap(node => [node, ...node.findAll(() => true)]).map(node => node.props?.children).flat(Infinity)
            .filter((part: unknown) => typeof part === 'string').join('');
        expect(text('projects-tree-row-billing/environment/prod:end')).toContain('v1.42');
        // The trouble is the shared plugin-ui Status, inline, in its tone; the quiet fact gives way to it.
        const stg = screen.findAll(node => node.props?.testID === 'projects-tree-row-billing/environment/stg:end' && node.props?.presentation === 'inline')[0]!;
        expect(stg.props).toMatchObject({ label: 'Deploy failed', tone: 'danger', presentation: 'inline' });
        expect(text('projects-tree-row-billing/environment/stg:end')).not.toContain('2h');
    });

    it('says a folded Project\'s Environment trouble with that Environment\'s state mark, not a hand-drawn dot (LIVE-FID-1115)', async () => {
        const env = (environmentId: string, state: Readonly<{ tone: 'danger' | 'warning' | null; text: string }> | null) => ({
            serverId: 'home', projectSourceId: 'src', environmentId, title: environmentId, titleQualifier: null, fact: 'v1', state,
            platform: null, attention: state ? (state.tone ? 'needs-you' as const : 'working' as const) : null });
        const folded = (environments: ReturnType<typeof env>[], checkoutAttention: 'needs-you' | null = null) => buildProjectsTreeRows({
            projects: [{ key: 'billing', name: 'billing', checkouts: [
                { refId: 'b1', machineId: 'devbox', machineName: 'devbox', label: 'main', path: '~/billing', attention: checkoutAttention },
            ], environments }], openRefId: null, expandedKeys: new Set() });
        const end = async (rows: ReturnType<typeof buildProjectsTreeRows>) => {
            const screen = await renderScreen(<ProjectsTree rows={rows} onToggle={() => {}} onOpenRef={() => {}} />);
            return {
                mark: screen.findAll(node => node.props?.presentation === 'inline' && node.props?.tone !== undefined
                    && typeof node.type !== 'string')[0]?.props ?? null,
                dot: screen.findByTestId('projects-tree-billing-needs-you'),
            };
        };
        const failed = await end(folded([env('prod', null), env('stg', { tone: 'danger', text: 'Deploy failed' })]));
        expect(failed.mark).toMatchObject({ label: 'Deploy failed', tone: 'danger' });
        expect(failed.dot).toBeNull();
        // A working deploy yields to a checkout that needs the person (that is a Session's fact, not the Environment's).
        const deploying = await end(folded([env('prod', { tone: null, text: 'Deploying' })], 'needs-you'));
        expect(deploying.mark).toBeNull();
        expect(deploying.dot).not.toBeNull();
    });

    it('is one keyboard tree: roving stop, arrows move, Space/Right disclose, Enter opens', async () => {
        const onToggle = vi.fn();
        const onOpenRef = vi.fn();
        const screen = await renderScreen(<ProjectsTree rows={rows} onToggle={onToggle} onOpenRef={onOpenRef} />);
        const item = (key: string) => screen.findAll((node) => node.props?.testID === `projects-tree-row-${key}:treeitem`
            && typeof node.props?.onKeyDown === 'function')[0]!;
        const press = async (key: string, keyboardKey: string) => {
            await act(async () => { item(key).props.onKeyDown({ key: keyboardKey, nativeEvent: { key: keyboardKey }, preventDefault: () => {} }); });
        };
        // One tab stop, on the first row; tree semantics carry level and expanded state.
        expect(item('plugins').props.tabIndex).toBe(0);
        expect(item('plugins/p1').props.tabIndex).toBe(-1);
        expect(item('plugins').props['aria-level']).toBe(1);
        expect(item('plugins/p1').props['aria-level']).toBe(2);
        expect(item('plugins').props['aria-expanded']).toBe(true);

        await press('plugins', 'ArrowDown');
        expect(item('plugins/p1').props.tabIndex).toBe(0);
        await press('plugins/p1', 'Enter');
        expect(onOpenRef.mock.calls[0]?.[0]).toBe('p1');

        // Enter on a Project opens it, like its press; Space on the open Project closes it in place.
        await press('plugins', 'Enter');
        expect(onOpenRef.mock.calls[1]?.[0]).toBe('p1');
        expect(onToggle).not.toHaveBeenCalled();
        await press('plugins', ' ');
        expect(onToggle).toHaveBeenCalledWith('plugins');
        expect(onToggle).toHaveBeenCalledTimes(1);
        await press('plugins/p2', 'End');
        await press('plugins/p2', 'Home');
        expect(item('plugins').props.tabIndex).toBe(0);
    });

    it('keeps focus in the tree when the focused checkout disappears (its Project closes or hides)', async () => {
        const screen = await renderScreen(<ProjectsTree rows={rows} onToggle={() => {}} onOpenRef={() => {}} />);
        const item = (key: string) => screen.findAll((node) => node.props?.testID === `projects-tree-row-${key}:treeitem`
            && typeof node.props?.onKeyDown === 'function')[0];
        await act(async () => { item('plugins/p2')!.props.onFocus(); });
        expect(item('plugins/p2')!.props.tabIndex).toBe(0);
        const collapsed = buildProjectsTreeRows({ projects: [{ key: 'plugins', name: 'happier-plugins', checkouts: [
            { refId: 'p1', machineId: 'devbox', machineName: 'devbox', label: 'main', path: '~/src/plugins', attention: null },
            { refId: 'p2', machineId: 'devbox', machineName: 'devbox', label: 'pi-agent', path: '~/x', attention: null },
        ] }], openRefId: null, expandedKeys: new Set(), collapsedKeys: new Set(['plugins']) });
        await screen.update(<ProjectsTree rows={collapsed} onToggle={() => {}} onOpenRef={() => {}} />);
        // The roving stop repairs to the nearest visible ancestor, never off the tree.
        expect(item('plugins')!.props.tabIndex).toBe(0);
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

    it('draws Hidden as the column\'s own disclosure row and still opens a hidden Project\'s exact checkout', async () => {
        const onOpenRef = vi.fn();
        const onToggle = vi.fn();
        const address = { serverId: 'home-a', workspaceId: 'scratch-ref', machineId: 'mbp', rootPath: '/Users/l/scratch-2024' };
        const render = (open: boolean) => (
            <ProjectsTree
                rows={rows}
                onToggle={() => {}}
                onOpenRef={onOpenRef}
                hidden={{ items: [{ key: 'scratch', title: 'scratch-2024', subtitle: 'MacBook Pro · ~/scratch-2024', refId: 'scratch-ref', workspaceAddress: address }],
                    open, onToggle, onShow: () => {} }}
            />
        );
        const screen = await renderScreen(render(false));
        // The disclosure announces its state wherever the row exposes it (aria-expanded on web).
        const expanded = () => {
            const node = screen.findAll((candidate) => candidate.props?.testID === 'projects-tree-hidden'
                && (candidate.props['aria-expanded'] !== undefined || candidate.props.accessibilityState?.expanded !== undefined))[0];
            return node?.props['aria-expanded'] ?? node?.props.accessibilityState?.expanded;
        };
        expect(expanded()).toBe(false);
        expect(screen.findByTestId('projects-tree-hidden-scratch')).toBeNull();
        await screen.pressByTestIdAsync('projects-tree-hidden');
        expect(onToggle).toHaveBeenCalledTimes(1);
        await screen.update(render(true));
        expect(expanded()).toBe(true);
        await screen.pressByTestIdAsync('projects-tree-hidden-scratch');
        expect(onOpenRef).toHaveBeenCalledWith('scratch-ref', address);
    });
});

describe('ProjectsTreeSkeletonRows', () => {
    it("stands the loading rows in the tree rows' own shape: two lines in the compact row box, glyph on the text edge", async () => {
        const { ProjectsTreeSkeletonRows } = await import('./ProjectsTree');
        const { HAPPIER_COLLECTION_LIST_METRICS } = await import('@happier-dev/plugin-ui/presentation');
        const { ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX, ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } = await import('@/components/ui/lists/itemDensityMetrics');
        const screen = await renderScreen(<ProjectsTreeSkeletonRows testID="tree-loading" rows={3} />);
        const rows = screen.root.findAll((node) => typeof node.type === 'string' && /^tree-loading:skeleton-row$/.test(String(node.props.testID)));
        expect(rows).toHaveLength(3);
        const style = Object.assign({}, ...[rows[0]!.props.style].flat(Infinity).filter(Boolean));
        // The navigation row's box: its least height and the two-line row's padding.
        expect(style.minHeight).toBe(HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight);
        expect(style.paddingTop).toBe(ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX.compact);
        // The glyph lands where the tree's folder does: on the column's text edge (no disclosure column).
        expect(style.paddingLeft).toBe(HAPPIER_COLLECTION_LIST_METRICS.contentInset);
        // Title and subtitle line boxes at the compact row's line heights.
        const lineBoxes = rows[0]!.findAll((node) => typeof node.type === 'string' && node.props.style
            && [node.props.style].flat(Infinity).some((entry: any) => entry?.justifyContent === 'center' && typeof entry?.height === 'number'));
        const heights = lineBoxes.map((node) => Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean)).height);
        expect(heights).toEqual([ITEM_TITLE_TEXT_METRICS.compact.lineHeight, ITEM_SUBTITLE_TEXT_METRICS.compact.lineHeight]);
    });
});
