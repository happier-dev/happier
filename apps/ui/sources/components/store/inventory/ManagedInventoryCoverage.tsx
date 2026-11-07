import * as React from 'react';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { ManagedInventorySectionsState } from './ManagedInventorySections';
import { inventoryFamilyDiagnosticCode } from './inventoryCoverage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { joinList } from '@/utils/text/joinList';

/** The kinds lead the line, so the list starts a sentence ("Software, MCP servers and skills"), not mid-sentence. */
function lineTitle(entries: readonly { kind: string }[]): string {
    const list = joinList(entries.map(entry => entry.kind));
    return list.charAt(0).toLocaleUpperCase() + list.slice(1);
}

/**
 * Family facts survive regrouping, retained rows and an empty filtered result. No reads happen here.
 * One quiet line per state naming its kinds ("apps, MCP servers and skills · Some of these haven't loaded yet."): a line
 * or a titled group per kind would stack the same sentence (STORE-UI-R2), and a titled group would read as a Kind
 * section inside the Machine and Project groupings (STORE-ACCEPT). Partial reads don't need the person, so the line
 * stays in the quiet unavailable ink, and the page header leaves the "may not be everything" sentence to this line.
 */
export function ManagedInventoryCoverage(props: Readonly<{
    families: ManagedInventorySectionsState['families'];
    testIDPrefix: string;
}>): React.ReactNode {
    const partial: { kind: string; retry: (() => unknown) | undefined }[] = [];
    const failed: { kind: string; code: string | undefined; retry: (() => unknown) | undefined }[] = [];
    for (const { kind, result } of props.families) {
        const coverage = result.coverage;
        if (typeof coverage !== 'object') continue;
        const entry = { kind: t(`capabilities.store.kindSentenceNames.${kind}`),
            retry: typeof result.continuation === 'function' ? result.continuation as () => unknown : undefined };
        if (!('unavailable' in coverage)) { partial.push(entry); continue; }
        failed.push({ ...entry, code: inventoryFamilyDiagnosticCode(coverage) });
    }
    const retryAction = (entries: typeof partial, state: string) => {
        const retries = entries.flatMap(entry => entry.retry ? [entry.retry] : []);
        return retries.length > 0 ? { label: t('capabilities.store.retry'), testID: `${props.testIDPrefix}.coverage.${state}.retry`, onPress: () => {
            for (const retry of retries) fireAndForget(Promise.resolve(retry()), { tag: 'ManagedInventoryCoverage.retry' });
        } } : undefined;
    };
    const lines = [
        partial.length > 0 ? <SurfaceStateCard key="partial" testID={`${props.testIDPrefix}.coverage.partial`} size="line"
            kind="unavailable" title={lineTitle(partial)} reason={t('storeInstalled.sectionPartial')}
            action={retryAction(partial, 'partial')} /> : null,
        failed.length > 0 ? <SurfaceStateCard key="unavailable" testID={`${props.testIDPrefix}.coverage.unavailable`} size="line"
            kind="unavailable" title={lineTitle(failed)}
            reason={t('storeInstalled.sectionUnavailable')}
            // Each failed kind keeps its own native reason for support, said once per distinct code.
            diagnosticCode={[...new Set(failed.flatMap(entry => entry.code ? [entry.code] : []))].join(', ') || undefined}
            action={retryAction(failed, 'unavailable')} /> : null,
    ].filter(Boolean);
    return lines.length ? <ItemGroup surface="none">{lines}</ItemGroup> : null;
}
