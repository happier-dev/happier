import * as React from 'react';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { resolveProfileBackendTargetKeyForEntry } from './profileBackendEntryStorage';

/** The same optional Session-start preference for current and retained Profiles. */
export function ProfilePreferredAgentField(props: Readonly<{
    entries: readonly ResolvedBackendCatalogEntry[];
    preferredAgentTargetKey?: string;
    onChange: (targetKey: string | undefined) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const selected = props.entries.find(entry => resolveProfileBackendTargetKeyForEntry(entry) === props.preferredAgentTargetKey);
    return <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        variant="selectable"
        search={props.entries.length >= 10}
        showCategoryTitles={false}
        rowKind="item"
        selectedId={props.preferredAgentTargetKey ?? '__none__'}
        itemTrigger={{
            title: t('profiles.preferredAgent.title'),
            subtitle: selected?.title ?? (props.preferredAgentTargetKey ? t('common.unavailable') : t('profiles.preferredAgent.none')),
            showSelectedDetail: false,
            showSelectedSubtitle: false,
        }}
        items={[
            { id: '__none__', title: t('profiles.preferredAgent.none') },
            ...props.entries.map(entry => ({ id: resolveProfileBackendTargetKeyForEntry(entry), title: entry.title, subtitle: entry.subtitle ?? undefined })),
        ]}
        onSelect={id => props.onChange(id === '__none__' ? undefined : id)}
    />;
}
