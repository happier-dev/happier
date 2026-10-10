import * as React from 'react';

import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { useArtifact } from '@/sync/domains/state/storage';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { t } from '@/text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * The facts that tell a saved prompt or skill apart, for its editor header: where it came from
 * (imported, built in) and how many places it is exported to. A new draft has none.
 */
export function usePromptLibraryEntryMeta(artifactId: string | null, qualified?: Readonly<{
    scope: ServerAccountScope | null; header: Readonly<Record<string, unknown>> | null;
}>): readonly PageHeaderMetaFact[] {
    const artifact = useArtifact(qualified ? '' : artifactId ?? '');
    const links = usePromptLibraryCatalogValue('external-links', qualified?.scope).value;
    const header = qualified ? qualified.header : artifact?.header;
    const origin = artifactId && typeof header?.origin === 'string' ? header.origin : null;
    const exportCount = artifactId ? (links?.links ?? []).filter((link) => link.artifactId === artifactId).length : 0;
    return React.useMemo(() => {
        const facts: PageHeaderMetaFact[] = [];
        if (origin === 'imported') facts.push({ key: 'origin', text: t('promptLibrary.imported') });
        if (origin === 'built_in') facts.push({ key: 'origin', text: t('promptLibrary.builtIn') });
        if (exportCount > 0) facts.push({ key: 'exports', text: t('promptLibrary.linkedAssetsCount', { count: exportCount }) });
        return facts;
    }, [exportCount, origin]);
}
