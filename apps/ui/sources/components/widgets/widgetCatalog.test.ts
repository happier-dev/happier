import { describe, expect, it } from 'vitest';
import { BUILTIN_WIDGET_DESCRIPTORS_V1, WIDGET_SIZE_POLICY_V1, WidgetInstanceV1Schema, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { getPreferredLanguage, preloadTranslationsForSettings, setPreferredLanguageFromSettings, t } from '@/text';
import { createPublicProfileWidgetAreaPresetsV1 } from '@happier-dev/protocol/widgets/publicProfileWidgetPresetsV1';

import {
    widgetInstalledPackage as installedPackage,
    widgetProjectionOf as projectionOf,
    type WidgetFixtureEntry,
} from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import {
    describeBuiltinWidgetInstance,
    describeWidgetDefinitionSummaryV1,
    isBuiltinWidgetSwitchedOff,
    readSessionHostWidgetDescriptor,
    readWidgetDescriptor,
    readWidgetSourcePluginName,
    resolveWidgetInstanceTitle,
    selectBuiltinWidgetCandidates,
    selectCurrentSessionWidgetCandidates,
    selectWidgetCandidates as selectUniversalWidgetCandidates,
} from './widgetCatalog';

/**
 * What a widget host may offer: the Board's Add picker (Session target) and Home's sections and
 * Add widgets (App target).
 *
 * The failures pinned here are the ones a person cannot see: an offered
 * candidate that can never mount because its qualified identity is ambiguous, a
 * row that names the wrong plugin, two same-named plugins that sound identical
 * to a screen reader, and a widget offered to a host it was not made for.
 */

const inlineEntry = (input: WidgetFixtureEntry): WidgetFixtureEntry => input;
const selectWidgetCandidates = (...args: Parameters<typeof selectUniversalWidgetCandidates>) => selectUniversalWidgetCandidates(...args)
    .filter(candidate => candidate.surface !== undefined);

function selectSessionWidgetCandidates(
    projection: PluginUiProjectionModel | null,
    policyContext?: PluginUiPolicyEvaluationContext,
) {
    return selectWidgetCandidates(projection, policyContext);
}

describe('Widget Add candidates', () => {
    it('names and configures a saved definition from its list projection without needing its body', () => {
        const candidate = describeWidgetDefinitionSummaryV1({ artifactId: 'checks', name: 'Checks on main',
            sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
            inputs: { fields: [{ path: 'repo', title: 'Repository', widget: 'text' }] },
            inputSchema: { type: 'object', properties: { repo: { type: 'string' } } }, bodyKind: 'declarative', resources: [] });
        expect(candidate).toMatchObject({ definition: { kind: 'artifact', artifactId: 'checks' }, title: 'Checks on main',
            inputs: { fields: [{ path: 'repo' }] }, target: 'app' });
        expect(candidate.authoredDefinition).toBeUndefined();
    });
    it('gives a built-in with no purpose of its own no description, instead of its title repeated', () => {
        const checkouts = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin' && candidate.definition.id === 'project_checkouts');
        expect(checkouts?.title).toBeTruthy();
        expect(checkouts?.description).toBeUndefined();
    });
    it('describes every Session built-in in words, never with its raw translation key', () => {
        const sessionBuiltins = selectBuiltinWidgetCandidates().filter(candidate => candidate.target === 'session');
        expect(sessionBuiltins.length).toBeGreaterThan(0);
        for (const candidate of sessionBuiltins) expect(candidate.description ?? '').not.toMatch(/^widgetAdd\.|^$/);
    });
    it('offers native glances through the universal catalog without a plugin occurrence or a fake plugin identity', () => {
        const candidates = selectUniversalWidgetCandidates(null);
        expect(candidates.filter(candidate => candidate.target === 'session')).toMatchObject([
            { definition: { kind: 'builtin', id: 'session_summary' }, target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } },
            { definition: { kind: 'builtin', id: 'agent_plan' }, target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } },
            { definition: { kind: 'builtin', id: 'changes' }, target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } },
            { definition: { kind: 'builtin', id: 'local_services' }, target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } },
            { definition: { kind: 'builtin', id: 'environment' }, target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } },
            { definition: { kind: 'builtin', id: 'running' }, target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } },
            { definition: { kind: 'builtin', id: 'usage' }, target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } },
            { definition: { kind: 'builtin', id: 'links' }, target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } },
        ]);
        expect(candidates.some(candidate => 'surface' in candidate)).toBe(false);
    });
    it('offers Session and App widgets together in every physical host catalog', () => {
        const projection = projectionOf([
            { pluginId: 'acme.review', localId: 'session' },
            { pluginId: 'acme.review', localId: 'app', target: 'app' },
        ], { 'acme.review': installedPackage('acme.review', 'Review') });
        expect(selectWidgetCandidates(projection).map((candidate) => [candidate.surface.localId, candidate.target]))
            .toEqual([['app', 'app'], ['session', 'session']]);
    });

    it('retains execution targets and declared Home defaults in universal candidates', () => {
        const projection = projectionOf(
            [
                inlineEntry({ pluginId: 'acme.review', localId: 'board-status', title: 'Board status' }),
                inlineEntry({ pluginId: 'acme.review', localId: 'latest', title: 'Latest', target: 'app', homeDefault: 'shown' }),
                inlineEntry({ pluginId: 'acme.review', localId: 'queue', title: 'Queue', target: 'app' }),
            ],
            { 'acme.review': installedPackage('acme.review', 'Review Assistant') },
        );
        expect(selectWidgetCandidates(projection).map((candidate) => [candidate.key, candidate.target, candidate.homeDefault]))
            .toEqual([['acme.review/board-status', 'session', 'available'], ['acme.review/latest', 'app', 'shown'], ['acme.review/queue', 'app', 'available']]);
    });

    it('names each candidate by its contribution title and installed plugin', () => {
        const candidates = selectSessionWidgetCandidates(projectionOf(
            [inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget', title: 'Review status' })],
            { 'acme.review': installedPackage('acme.review', 'Review Assistant') },
        ));
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            surface: { pluginId: 'acme.review', localId: 'review-status-widget' },
            title: 'Review status',
            pluginName: 'Review Assistant',
            sharedPluginName: false,
        });
    });

    it('names a saved copy of an installed widget by that widget\u2019s plugin, not by its own name (already its title)', () => {
        const projection = projectionOf(
            [inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget', title: 'Review status' })],
            { 'acme.review': installedPackage('acme.review', 'Review Assistant') },
        );
        const saved = describeWidgetDefinitionSummaryV1({ artifactId: 'copy', name: 'Review status', sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
            bodyKind: 'installed', resources: [],
            sourceDefinition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status-widget' } } } as unknown as Parameters<typeof describeWidgetDefinitionSummaryV1>[0]);
        expect(readWidgetSourcePluginName(projection, saved)).toBe('Review Assistant');
        const plain = describeWidgetDefinitionSummaryV1({ artifactId: 'plain', name: 'Checks', sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
            inputs: { fields: [] }, inputSchema: { type: 'object', properties: {} }, bodyKind: 'declarative', resources: [] });
        expect(readWidgetSourcePluginName(projection, plain)).toBe('Checks');
    });

    it('never offers a role that merely shares the local id', () => {
        expect(selectSessionWidgetCandidates(projectionOf(
            [inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget', role: 'sessionSubagentDetails' })],
            { 'acme.review': installedPackage('acme.review', 'Review Assistant') },
        ))).toEqual([]);
    });

    it('refuses an unavailable surface as a NEW creation candidate', () => {
        const projection = projectionOf(
            [inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget', availability: 'unavailable' })],
            { 'acme.review': installedPackage('acme.review', 'Review Assistant') },
        );
        expect(selectSessionWidgetCandidates(projection)).toEqual([]);
        expect(selectSessionWidgetCandidates(projection)).toEqual([]);
    });

    it('drops an ambiguous qualified identity instead of offering an item that cannot mount', () => {
        // The mount resolver fails closed on a duplicate identity. Offering one
        // here would create a Board item that is permanently unavailable.
        const candidates = selectSessionWidgetCandidates(projectionOf(
            [
                inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget' }),
                inlineEntry({
                    pluginId: 'acme.review',
                    localId: 'review-status-widget',
                    entryId: 'surfacePlacement:acme.review:review-status-widget-duplicate',
                }),
                inlineEntry({ pluginId: 'acme.ci', localId: 'build-health', title: 'Build health' }),
            ],
            {
                'acme.review': installedPackage('acme.review', 'Review Assistant'),
                'acme.ci': installedPackage('acme.ci', 'CI Tools'),
            },
        ));
        expect(candidates.map((candidate) => candidate.surface.localId)).toEqual(['build-health']);
    });

    it('marks a colliding plugin display name so rows stay distinguishable', () => {
        const candidates = selectSessionWidgetCandidates(projectionOf(
            [
                inlineEntry({ pluginId: 'acme.review', localId: 'status', title: 'Status' }),
                inlineEntry({ pluginId: 'other.review', localId: 'status', title: 'Status' }),
            ],
            {
                'acme.review': installedPackage('acme.review', 'Review'),
                'other.review': installedPackage('other.review', 'Review'),
            },
        ));
        expect(candidates.map((candidate) => candidate.sharedPluginName)).toEqual([true, true]);
    });

    it('rejects duplicate identities even when availability hides one from the picker', () => {
        const projection = projectionOf([
            { pluginId: 'acme.review', localId: 'split' },
            { pluginId: 'acme.review', localId: 'split', target: 'app', entryId: 'split-app' },
            { pluginId: 'acme.review', localId: 'hidden' },
            { pluginId: 'acme.review', localId: 'hidden', availability: 'unavailable', entryId: 'hidden-unavailable' },
        ], { 'acme.review': installedPackage('acme.review', 'Review') });
        expect(selectWidgetCandidates(projection)).toEqual([]);
    });

    it('omits a projected contribution whose installed package row is absent', () => {
        // Without a package row there is no truthful provenance, so the person
        // cannot tell what they would be adding.
        expect(selectSessionWidgetCandidates(projectionOf(
            [inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget' })],
        ))).toEqual([]);
    });

    it('reports no candidates at all without a projection', () => {
        expect(selectSessionWidgetCandidates(null)).toEqual([]);
    });

    it.each([
        {
            gate: 'the exact Home feature decision',
            entry: inlineEntry({
                pluginId: 'acme.review',
                localId: 'feature-widget',
                featureGate: 'sessions.board',
            }),
            admitted: { platform: 'web', isFeatureEnabled: (id: string) => id === 'sessions.board' },
            refused: { platform: 'web', isFeatureEnabled: () => false },
        },
        {
            gate: 'the exact Session capability decision',
            entry: inlineEntry({
                pluginId: 'acme.review',
                localId: 'permission-widget',
                capabilityIds: ['session.records.read'],
            }),
            admitted: { platform: 'web', isCapabilityEnabled: (id: string) => id === 'session.records.read' },
            refused: { platform: 'web', isCapabilityEnabled: () => false },
        },
        {
            gate: 'the current host platform',
            entry: inlineEntry({
                pluginId: 'acme.review',
                localId: 'platform-widget',
                platforms: ['web'],
            }),
            admitted: { platform: 'web' },
            refused: { platform: 'ios' },
        },
    ] satisfies readonly Readonly<{
        gate: string;
        entry: WidgetFixtureEntry;
        admitted: PluginUiPolicyEvaluationContext;
        refused: PluginUiPolicyEvaluationContext;
    }>[])('keeps Add entry visibility identical to the picker for $gate', ({ entry, admitted, refused }) => {
        const projection = projectionOf(
            [entry],
            { 'acme.review': installedPackage('acme.review', 'Review Assistant') },
        );

        const admittedCandidates = selectSessionWidgetCandidates(projection, admitted);
        const refusedCandidates = selectSessionWidgetCandidates(projection, refused);
        expect(admittedCandidates).toHaveLength(1);
        expect(refusedCandidates).toEqual([]);
    });

    it.each([
        { label: 'Board feature is disabled', boardFeatureEnabled: false, canEdit: true, phase: 'current', interactionEnabled: true },
        { label: 'Session editor permission is absent', boardFeatureEnabled: true, canEdit: false, phase: 'current', interactionEnabled: true },
        { label: 'plugin projection is retained offline', boardFeatureEnabled: true, canEdit: true, phase: 'retainedOffline', interactionEnabled: false },
        { label: 'plugin projection is establishing', boardFeatureEnabled: true, canEdit: true, phase: 'establishing', interactionEnabled: false },
    ] as const)('keeps native candidates independent of plugin currentness but preserves Board admission when $label', (state) => {
        const pluginUiProjection = projectionOf(
            [inlineEntry({ pluginId: 'acme.review', localId: 'review-status-widget' })],
            { 'acme.review': installedPackage('acme.review', 'Review Assistant') },
        );
        const runtime = {
            pluginUiProjection,
            pluginBrowserProjection: null,
            machineId: 'machine-a',
            serverId: 'home-a',
            platform: 'web',
            phase: state.phase,
            interactionEnabled: state.interactionEnabled,
            accountLifetime: null,
        } satisfies SessionPluginRuntimeState;

        const candidates = selectCurrentSessionWidgetCandidates({
            runtime,
            boardFeatureEnabled: state.boardFeatureEnabled,
            canEdit: state.canEdit,
            policyContext: { platform: 'web' },
        });
        expect(candidates.filter(candidate => candidate.surface)).toEqual([]);
        expect(candidates.map(candidate => candidate.definition)).toEqual(state.boardFeatureEnabled && state.canEdit
            ? BUILTIN_WIDGET_DESCRIPTORS_V1.map(descriptor => descriptor.definition) : []);
    });
});

describe('Your Home, the atmosphere widget', () => {
    const yourHome = (moments: Readonly<Record<string, boolean>>) => selectUniversalWidgetCandidates(null, undefined, moments)
        .find(candidate => candidate.key === 'builtin:your_home');

    it('is offered as a built-in App widget at the four Home sizes while its moment is on', () => {
        expect(yourHome({ yourHome: true })).toMatchObject({
            definition: { kind: 'builtin', id: 'your_home' }, target: 'app', icon: 'house',
            sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full'], defaultSize: 'medium' },
        });
        // A stored map without the key keeps the default (on).
        expect(yourHome({})).toBeDefined();
    });

    it('is withdrawn from every creation path when the person switches the moment off', () => {
        expect(yourHome({ yourHome: false })).toBeUndefined();
        expect(selectBuiltinWidgetCandidates({ yourHome: false }).some(candidate => candidate.key === 'builtin:your_home')).toBe(false);
        expect(isBuiltinWidgetSwitchedOff({ kind: 'builtin', id: 'your_home' }, { yourHome: false })).toBe(true);
        expect(isBuiltinWidgetSwitchedOff({ kind: 'builtin', id: 'your_home' }, { yourHome: true })).toBe(false);
        expect(isBuiltinWidgetSwitchedOff({ kind: 'builtin', id: 'usage_daily' }, { yourHome: false })).toBe(false);
    });
});

describe('A built-in called by what its inputs make it show', () => {
    const breakdowns = selectBuiltinWidgetCandidates({}).find(candidate => candidate.key === 'builtin:usage_breakdowns')!;
    const placed = (breakdown?: readonly string[]): WidgetInstanceV1 => ({ v: 1, id: 'w', definition: { kind: 'builtin', id: 'usage_breakdowns' },
        bindings: breakdown ? { breakdown: { kind: 'value', value: [...breakdown] } } : {} });

    it('tells two Usage Breakdowns widgets apart by the one dimension each ranks, and leaves the default pair as Breakdowns', () => {
        const titles = [['model'], ['machine'], ['agent'], ['model', 'machine'], undefined]
            .map(breakdown => describeBuiltinWidgetInstance(breakdowns, placed(breakdown)).title);
        expect(titles[0]).not.toBe(breakdowns.title);
        expect(titles[1]).not.toBe(titles[0]);
        expect(new Set(titles.slice(0, 3)).size).toBe(3);
        expect(titles.slice(3)).toEqual([breakdowns.title, breakdowns.title]);
    });
});

describe('The title a widget instance wears', () => {
    const instance = (definition: WidgetInstanceV1['definition'], displayName?: string): WidgetInstanceV1 =>
        ({ v: 1, id: 'w', definition, bindings: {}, ...(displayName ? { displayName } : {}) });

    it('localizes a retained preset style title while preserving an authored name and a different selected style', async () => {
        const language = getPreferredLanguage();
        try {
            setPreferredLanguageFromSettings('en');
            const preset = createPublicProfileWidgetAreaPresetsV1({ title: presentation =>
                presentation.widgetId === 'usage_rhythm' && presentation.inputs.style === 'sky'
                    ? t('publicIdentity.blocks.sky') : undefined });
            const item = preset.find(entry => entry.id === 'minimal')!.items.find(entry => entry.kind === 'widget' && entry.instance.id === 'days');
            if (item?.kind !== 'widget') throw new Error('Missing public profile days preset');
            const saved = WidgetInstanceV1Schema.parse(item.instance);
            if (saved.definition.kind !== 'builtin') throw new Error('Expected the built-in public profile days widget');
            await preloadTranslationsForSettings('fr');
            setPreferredLanguageFromSettings('fr');
            const candidate = readWidgetDescriptor(null, saved.definition);
            const title = t('usage.board.charts.inputSky');
            expect(title).not.toBe(saved.displayName);
            expect(resolveWidgetInstanceTitle(saved, candidate)).toBe(title);
            expect(resolveWidgetInstanceTitle({ ...saved, displayName: 'Our working days' }, candidate)).toBe('Our working days');
            expect(resolveWidgetInstanceTitle({ ...saved, bindings: { style: { kind: 'value', value: 'weekTide' } } }, candidate)).toBe(saved.displayName);
        } finally {
            setPreferredLanguageFromSettings(language);
        }
    });

    it('waits only for a pending name and keeps known names through pending or failed reads', () => {
        const saved = instance({ kind: 'artifact', artifactId: 'private' });
        expect(resolveWidgetInstanceTitle(saved, null, { definitionState: 'loading' })).toBeNull();
        expect(resolveWidgetInstanceTitle(saved, null, { definitionState: 'unavailable' })).toBe(resolveWidgetInstanceTitle(saved, null));
        expect(resolveWidgetInstanceTitle({ ...saved, displayName: 'Mine' }, null, { definitionState: 'loading' })).toBe('Mine');
        expect(resolveWidgetInstanceTitle(saved, { title: 'Resolved' }, { definitionState: 'unavailable' })).toBe('Resolved');
        expect(resolveWidgetInstanceTitle(saved, null, { fallbackTitle: 'Retained Session name' })).toBe('Retained Session name');
        expect(resolveWidgetInstanceTitle(instance({ kind: 'builtin', id: 'usage_daily' }), null, { projectionPending: true })).toBeNull();
    });

    it('keeps its own name, then its definition title, and never names a private definition by a status phrase', () => {
        const candidate = selectBuiltinWidgetCandidates({}).find(entry => entry.key === 'builtin:usage_breakdowns')!;
        expect(resolveWidgetInstanceTitle(instance({ kind: 'builtin', id: 'usage_breakdowns' }, 'Mine'), candidate)).toBe('Mine');
        expect(resolveWidgetInstanceTitle(instance({ kind: 'builtin', id: 'usage_breakdowns' }), candidate)).toBe(candidate.title);
        const privateDefinition = resolveWidgetInstanceTitle(instance({ kind: 'artifact', artifactId: 'owner-private' }), null);
        const missingPlugin = resolveWidgetInstanceTitle(instance({ kind: 'installed', surface: { pluginId: 'acme.gone', localId: 'w' } }), null);
        expect(privateDefinition).not.toBe(missingPlugin);
        expect(privateDefinition).not.toMatch(/unavailable/i);
    });

    it('names a shared private-definition placement from its existing stored displayName without opening the definition', () => {
        const shared = instance({ kind: 'artifact', artifactId: 'maker-private-definition' }, 'Release health');
        expect(resolveWidgetInstanceTitle(shared, null, { definitionState: 'unavailable' })).toBe('Release health');
        expect(resolveWidgetInstanceTitle(shared, { title: 'Definition title' })).toBe('Release health');
        const { displayName: _storedTitle, ...olderLayout } = shared;
        expect(resolveWidgetInstanceTitle(olderLayout, null, { definitionState: 'unavailable' })).toBe(t('composerReferences.kindWidget'));
    });
});

describe('Session host widget naming', () => {
    // The app shell names only App and Project placements; a Session-target widget is published by the
    // exact Session's Machine projection. A Companion or Board copy must still be named (and mounted).
    it('names a Session-target widget from the exact Session projection when the app shell does not publish it', () => {
        const packages = { 'acme.review': installedPackage('acme.review', 'Review Assistant') };
        const app = projectionOf([{ pluginId: 'acme.review', localId: 'latest', title: 'Latest', target: 'app' }], packages);
        const session = projectionOf([{ pluginId: 'acme.review', localId: 'review-status', title: 'Review status' }], packages);
        const sessionWidget = { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status' } } as const;
        const appWidget = { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'latest' } } as const;

        expect(readWidgetDescriptor(app, sessionWidget)).toBeNull();
        expect(readSessionHostWidgetDescriptor({ app, session }, sessionWidget))
            .toMatchObject({ title: 'Review status', pluginName: 'Review Assistant', target: 'session' });
        expect(readSessionHostWidgetDescriptor({ app, session: null }, appWidget)?.title).toBe('Latest');
        expect(readSessionHostWidgetDescriptor({ app, session: null }, sessionWidget)).toBeNull();
    });
});
