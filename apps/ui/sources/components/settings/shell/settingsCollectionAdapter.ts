import type { ReactNode } from 'react';
import type { HappierCollectionRowContentProps } from '@happier-dev/plugin-ui/presentation';
import { createEntityFilterConditionCodecV1, defineEntityFilterFieldV1, defineEntityFilterUnknownFieldsV1, type EntityFilterRegistryV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import { matchEntityFilterSetV1, StringSetSelectionV1Schema, type SetSelectionV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';

/** Presentation input only: each domain keeps its identity, status and hierarchy authorities. */
export type SettingsCollectionRowFacts<Field extends string = string> = Readonly<{
    key: string;
    title: string;
    context: string | null;
    status: string | null;
    count?: number | null;
    children?: readonly string[];
    expanded?: boolean;
    /** Already chosen by the domain's rollup owner; never ranked across unrelated domains. */
    rollup?: string | null;
    fields: Readonly<Partial<Record<Field, readonly string[] | null>>>;
}>;
/** A draft can retain opaque future fields; the registry, not its type, admits known conditions. */
export type SettingsCollectionFilter = Readonly<Record<string, SetSelectionV1<string> | undefined>>;
export type SettingsCollectionSlotRenderers = Readonly<{
    identity: ReactNode;
    status: (status: string, options: Readonly<{ iconOnly: true }>) => ReactNode;
    count: (count: number) => ReactNode;
    trailing: (status: ReactNode, count: ReactNode) => ReactNode;
    context: (line: string) => ReactNode;
}>;

export type SettingsCollectionAdapter<Field extends string> = {
    fields: readonly Field[];
    registry: EntityFilterRegistryV1<SettingsCollectionFilter, SettingsCollectionRowFacts<Field>>;
    slots(row: SettingsCollectionRowFacts<Field>, render: SettingsCollectionSlotRenderers): Pick<
        HappierCollectionRowContentProps, 'identity' | 'title' | 'children' | 'trailing'
    >;
};

// Selection value admission only; P6 owns condition editing and filter evaluation.
const setConditions = createEntityFilterConditionCodecV1<SetSelectionV1<string>>({
    encoding: 'set', parseValue: value => StringSetSelectionV1Schema.parse(value),
});

/** Binds existing content slots only. Navigation, layout, fetching and filter evaluation stay outside. */
export function defineSettingsCollectionAdapter<const Field extends string>(fields: readonly Field[]): SettingsCollectionAdapter<Field> {
    type Filter = SettingsCollectionFilter;
    type Facts = SettingsCollectionRowFacts<Field>;
    const registry: EntityFilterRegistryV1<Filter, Facts> = [
        ...fields.map(id => defineEntityFilterFieldV1<Filter, Facts, SetSelectionV1<string>>({
            id, kind: 'set', evaluators: ['list'],
            conditions: setConditions,
            readSelection: filter => filter[id],
            replaceSelection: (filter, selection) => {
                if (selection !== undefined) return { ...filter, [id]: selection };
                const next = { ...filter };
                delete next[id];
                return next;
            },
            match: (selection, facts) => matchEntityFilterSetV1(selection, value => {
                const values = facts.fields[id];
                return values == null ? 'unavailable' : values.includes(value) ? 'match' : 'miss';
            }),
        })),
        defineEntityFilterUnknownFieldsV1<Filter, Facts>(fields),
    ];
    return {
        fields,
        registry,
        slots(row: SettingsCollectionRowFacts<Field>, render: SettingsCollectionSlotRenderers): Pick<
            HappierCollectionRowContentProps, 'identity' | 'title' | 'children' | 'trailing'
        > {
            const status = row.expanded ? row.status : row.rollup ?? row.status;
            return {
                identity: render.identity,
                title: row.title,
                children: row.context ? render.context(row.context) : null,
                trailing: render.trailing(status ? render.status(status, { iconOnly: true }) : null,
                    row.count === undefined || row.count === null ? null : render.count(row.count)),
            };
        },
    };
}
