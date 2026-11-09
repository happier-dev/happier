import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { readCurrentAppShellPluginUiProjection, readCurrentAppShellPluginUiTranslationRuntime } from '@/components/appShell/plugins/committedPluginUiProjection';
import { selectPluginPagePlacements } from '@/components/plugins/pages/pluginPages';
import { resolveProjectPageCatalog } from '@/components/projects/detail/projectPageCatalog';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { getPreferredLanguage } from '@/text';

import type { LazyActionAccountContext } from './actionAccountContext';
import { readProjectActionContext } from './projectActionContext';

function refused(errorCode: string) { return { ok: false as const, errorCode, error: errorCode }; }

/** Descriptive discovery uses the same admitted Project/page owners as the mounted shell. */
export function createUiProjectPagesList(account?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['projectsPagesList']> {
    return async (args, context) => {
        if (!account) return refused('not_authenticated');
        const scope = { serverId: account.serverId, accountId: account.accountId };
        const projection = readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true });
        const placements = projection ? selectPluginPagePlacements(projection, { container: 'appPage', targetKind: 'project' }) : [];
        const admitted = await readProjectActionContext(account, args, context, { readSource: placements.length > 0 });
        if (!admitted.ok) return admitted;
        if (!projection) return refused('project_page_catalog_unavailable');
        const { ref, projectContext } = admitted;
        const locale = getPreferredLanguage();
        const runtime = readCurrentAppShellPluginUiTranslationRuntime(projection, { scope, declarationsOnly: true });
        const localize = createPluginLocalizedTextResolver({ projection, runtime, locale });
        const demandedPlugins = new Set<string>();
        const catalog = (resolve: typeof localize) => resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: ref.id, serverId: account.serverId },
            placements,
            policyContext: projectContext.policyContext,
            localize: resolve,
        });
        let pages = catalog((pluginId, value) => {
            if (typeof value === 'object' && value !== null && 'key' in value) demandedPlugins.add(pluginId);
            return localize(pluginId, value);
        });
        if (runtime) {
            await Promise.all([...demandedPlugins].map(pluginId => runtime.demand(pluginId, locale)));
            context?.signal?.throwIfAborted();
            account.assertCurrent();
            pages = catalog(localize);
        }
        return { pages: pages.map(page => {
            const descriptor = { id: page.id, title: page.title, icon: page.icon, href: page.href, disabledReason: page.disabledReason };
            if (page.kind === 'plugin') {
                if (!page.destination) throw new Error('A plugin Project page must have a qualified destination');
                return { ...descriptor, kind: 'plugin' as const, destination: page.destination };
            }
            return { ...descriptor, kind: 'builtin' as const };
        }) };
    };
}
