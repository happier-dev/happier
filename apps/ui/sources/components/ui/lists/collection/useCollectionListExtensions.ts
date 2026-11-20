import * as React from 'react';
import type { CollectionField } from '@happier-dev/plugin-ui';
import { admitPluginListFilterFieldV1, admitPluginListFilterFieldValueV1, type AdmittedPluginListFilterFieldV1 } from '@happier-dev/plugin-sdk/ui';
import type { PluginCollectionListExtensionV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { useAppShellPluginUiDeclarationProjection, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { t, usePreferredLanguage } from '@/text';

type Reader<Row> = (row: Row) => unknown;
type RowDetail<Row> = Readonly<{
    id: string;
    title: string;
    slot: 'context' | 'mark';
    render: (row: Row) => string | null;
}>;

export type CollectionListExtensions<Row> = Readonly<{
    columns: readonly CollectionField<Row>[];
    details: readonly RowDetail<Row>[];
}>;

export function useCollectionListExtensions<Row>(
    entity: PluginCollectionListExtensionV1['entity'],
    readFacts: ReadonlyMap<string, Reader<Row>>,
): CollectionListExtensions<Row> {
    const projection = useAppShellPluginUiDeclarationProjection();
    const localize = useProjectedPluginLocalizedTextResolver();
    const language = usePreferredLanguage();
    return React.useMemo(() => {
        const extensions = Object.values(projection?.listExtensionsById ?? {})
            .filter(extension => extension.listExtension.entity === entity);
        const fields = new Map<string, Readonly<{
            pluginId: string;
            field: AdmittedPluginListFilterFieldV1;
            render: (row: Row) => string | null;
        }>>();
        const columns: CollectionField<Row>[] = [];
        const dates = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
        const numbers = new Intl.NumberFormat(language);
        const factKeys = new Set(readFacts.keys());
        for (const extension of extensions) {
            const { pluginId } = extension;
            for (const declaration of extension.listExtension.filterFields ?? []) {
                if (!('factKey' in declaration.source)) continue;
                const result = admitPluginListFilterFieldV1({ pluginId, field: declaration, factKeys });
                if (result.kind !== 'admitted' || fields.has(result.field.id)) continue;
                const { id, declaration: field } = result.field;
                const read = readFacts.get(declaration.source.factKey);
                if (!read) continue;
                const optionLabels = field.value.kind === 'set'
                    ? new Map(field.value.options?.map(option => [option.value, localize(pluginId, option.title)])) : null;
                const render = (row: Row) => {
                    const value = read(row);
                    if (value == null) return null;
                    const admitted = admitPluginListFilterFieldValueV1(field, value);
                    if (admitted.kind !== 'available') return null;
                    const scalar = admitted.value;
                    if (typeof scalar === 'boolean') return scalar ? t('common.yes') : t('common.no');
                    if (typeof scalar === 'number') {
                        if (field.value.kind === 'number') return `${numbers.format(scalar)} ${field.value.unit}`;
                        return Number.isFinite(new Date(scalar).getTime()) ? dates.format(scalar) : null;
                    }
                    if (typeof scalar === 'string') return optionLabels?.get(scalar) ?? scalar;
                    return scalar?.map(option => optionLabels?.get(option) ?? option).join(', ') || null;
                };
                fields.set(id, { pluginId, field: result.field, render });
                if (field.column) {
                    const { column } = field;
                    columns.push({
                        key: id,
                        title: localize(pluginId, column.title ?? field.title),
                        ...(column.qualifier ? { subtitle: localize(pluginId, column.qualifier) } : {}),
                        description: localize(pluginId, field.title),
                        source: projection?.installedPackagesById[pluginId]?.displayName ?? pluginId,
                        minWidth: column.width ?? 112,
                        priority: column.priority ?? 0,
                        align: column.align,
                        defaultHidden: column.defaultHidden ?? true,
                        render,
                    });
                }
            }
        }
        const details: RowDetail<Row>[] = [];
        const named = new Set<string>();
        for (const extension of extensions) {
            const mark = extension.listExtension.rowMark;
            if (!mark || named.has(mark.fieldId)) continue;
            const field = fields.get(mark.fieldId);
            if (!field || field.pluginId !== extension.pluginId) continue;
            named.add(mark.fieldId);
            details.push({ id: mark.fieldId, title: localize(field.pluginId, field.field.declaration.title),
                slot: mark.slot, render: field.render });
        }
        return { columns, details };
    }, [entity, language, localize, projection?.installedPackagesById, projection?.listExtensionsById, readFacts]);
}

export function readCollectionPluginDetails<Row>(
    details: readonly RowDetail<Row>[],
    choices: Readonly<Record<string, boolean>> | undefined,
    row: Row,
    slot: RowDetail<Row>['slot'],
    defaultEnabled = false,
): string | null {
    return details.flatMap(detail => {
        if (detail.slot !== slot || !(choices?.[detail.id] ?? defaultEnabled)) return [];
        const value = detail.render(row);
        return value === null ? [] : [`${detail.title}: ${value}`];
    }).join(' · ') || null;
}
