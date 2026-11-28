import { z } from '../../zodRuntimePolicy.js';
import {
    CollectionArtifactPresentationSchema,
    CollectionLinesSchema,
    CollectionPluginDetailPreferencesSchema,
    CollectionTableCardPresentationSchema,
    CollectionWorkflowGroupingSchema,
    CollectionWorkflowRunGroupingSchema,
    SessionCollectionRowDetailsSchema,
    type AccountSettings,
    type SessionCollectionRowDetails,
    type CollectionLines,
} from '../../account/settings/accountSettings.js';
import type { PortableAccountSettingBindingV1 } from './accountSettingBindings.js';

const WorkflowDisplayPatch = z.strictObject({
    kind: z.literal('workflow'),
    presentation: z.optional(CollectionTableCardPresentationSchema),
    groupBy: z.optional(CollectionWorkflowGroupingSchema),
    lines: z.optional(CollectionLinesSchema),
    details: z.optional(CollectionPluginDetailPreferencesSchema),
});
const ArtifactView = z.strictObject({ presentation: CollectionArtifactPresentationSchema });
const ArtifactDisplayPatch = z.strictObject({
    kind: z.literal('artifact'),
    ...ArtifactView.shape,
});
const SessionDisplayPatch = z.strictObject({
    kind: z.literal('sessionWork'),
    lines: z.optional(CollectionLinesSchema),
    groupBy: z.optional(z.enum(['projects', 'recent_activity'])),
    details: z.optional(z.strictObject({
        ...SessionCollectionRowDetailsSchema.shape,
        rowContext: z.optional(z.boolean()),
        statusWords: z.optional(z.boolean()),
    })),
});
const WorkflowRunDisplayPatch = z.strictObject({
    kind: z.literal('workflowRun'),
    groupBy: z.optional(CollectionWorkflowRunGroupingSchema),
    lines: z.optional(CollectionLinesSchema),
    details: z.optional(CollectionPluginDetailPreferencesSchema),
});
const CollectionDisplayIntentSchema = z.discriminatedUnion('kind', [
    WorkflowDisplayPatch, ArtifactDisplayPatch, SessionDisplayPatch, WorkflowRunDisplayPatch,
]);

const SESSION_DENSITY_BY_LINES = { 1: 'narrow', 2: 'cozy', 3: 'detailed' } as const;
type CollectionDisplaySettings = Pick<AccountSettings,
    'collectionDisplayPreferencesV1' | 'sessionListDensity' | 'sessionListLayoutV1' |
    'sessionListRowContextV1' | 'sessionListStatusWords'>;

export function readSessionCollectionLines(density: CollectionDisplaySettings['sessionListDensity']): CollectionLines {
    return density === 'detailed' ? 3 : density === 'cozy' ? 2 : 1;
}

export function readSessionCollectionRowDetails(
    details: Partial<SessionCollectionRowDetails> | undefined,
    rowContext: boolean,
): SessionCollectionRowDetails {
    return {
        currentWork: details?.currentWork ?? true,
        progress: details?.progress ?? true,
        latestMessage: details?.latestMessage ?? false,
        project: details?.project ?? rowContext,
        machine: details?.machine ?? rowContext,
        branch: details?.branch ?? rowContext,
        pullRequest: details?.pullRequest ?? false,
        changes: details?.changes ?? false,
    };
}

function changedDetails(current: Readonly<Record<string, boolean | undefined>> | undefined,
    patch: Readonly<Record<string, boolean | undefined>> | undefined): boolean {
    return Object.entries(patch ?? {}).some(([key, value]) => value !== undefined && current?.[key] !== value);
}

function readCollectionDisplay(settings: CollectionDisplaySettings) {
    return {
        ...settings.collectionDisplayPreferencesV1,
        sessionWork: {
            lines: readSessionCollectionLines(settings.sessionListDensity),
            groupBy: settings.sessionListLayoutV1,
            details: {
                ...readSessionCollectionRowDetails(settings.collectionDisplayPreferencesV1.sessionWork?.details, settings.sessionListRowContextV1),
                rowContext: settings.sessionListRowContextV1,
                statusWords: settings.sessionListStatusWords,
            },
        },
    };
}

export const collectionDisplayStorageBinding: PortableAccountSettingBindingV1 = {
    scope: 'account',
    kind: 'owner',
    access: 'read_write',
    read: readCollectionDisplay,
    parse: value => {
        const result = CollectionDisplayIntentSchema.safeParse(value);
        return result.success ? { success: true, value: result.data } : { success: false };
    },
    mutate: (settings, value) => {
        const intent = value as z.infer<typeof CollectionDisplayIntentSchema>;
        if (intent.kind === 'sessionWork') {
            const { lines, groupBy, details } = intent;
            const delta: Partial<CollectionDisplaySettings> = {};
            if (lines !== undefined && SESSION_DENSITY_BY_LINES[lines] !== settings.sessionListDensity) {
                delta.sessionListDensity = SESSION_DENSITY_BY_LINES[lines];
            }
            if (groupBy !== undefined && groupBy !== settings.sessionListLayoutV1) delta.sessionListLayoutV1 = groupBy;
            if (details?.rowContext !== undefined && details.rowContext !== settings.sessionListRowContextV1) {
                delta.sessionListRowContextV1 = details.rowContext;
            }
            if (details?.statusWords !== undefined && details.statusWords !== settings.sessionListStatusWords) {
                delta.sessionListStatusWords = details.statusWords;
            }
            if (details) {
                const { rowContext: _rowContext, statusWords: _statusWords, ...detailPatch } = details;
                const preferences = settings.collectionDisplayPreferencesV1;
                const current = preferences.sessionWork?.details;
                if (changedDetails(current, detailPatch)) {
                    delta.collectionDisplayPreferencesV1 = {
                        ...preferences,
                        sessionWork: { ...preferences.sessionWork, details: { ...current, ...detailPatch } },
                    };
                }
            }
            return delta;
        }
        const preferences = settings.collectionDisplayPreferencesV1;
        if (intent.kind === 'artifact') {
            const { presentation } = intent;
            if (presentation === preferences.artifact?.presentation) return {};
            return { collectionDisplayPreferencesV1: { ...preferences, artifact: { ...preferences.artifact, presentation } } };
        }
        const { kind, details, lines, groupBy } = intent;
        const current = preferences[kind];
        const changed = changedDetails(current?.details, details);
        const changedPresentation = intent.kind === 'workflow' && intent.presentation !== undefined
            && intent.presentation !== preferences.workflow?.presentation;
        if (!changed && !changedPresentation && (lines === undefined || lines === current?.lines)
            && (groupBy === undefined || groupBy === current?.groupBy)) return {};
        const common = {
            ...(lines === undefined ? {} : { lines }),
            ...(changed ? { details: { ...current?.details, ...details } } : {}),
        };
        if (intent.kind === 'workflow') {
            const { presentation, groupBy } = intent;
            return { collectionDisplayPreferencesV1: { ...preferences, workflow: {
                ...preferences.workflow, ...common,
                ...(presentation === undefined ? {} : { presentation }),
                ...(groupBy === undefined ? {} : { groupBy }),
            } } };
        }
        return { collectionDisplayPreferencesV1: { ...preferences, workflowRun: {
            ...preferences.workflowRun, ...common,
            ...(intent.groupBy === undefined ? {} : { groupBy: intent.groupBy }),
        } } };
    },
};

/** Previously shipped Action address, backed by the same Account mutation as the view switch. */
export const artifactCollectionDisplayStorageBinding: typeof collectionDisplayStorageBinding = {
    ...collectionDisplayStorageBinding,
    read: settings => settings.collectionDisplayPreferencesV1.artifact ?? null,
    parse: value => {
        const result = ArtifactView.safeParse(value);
        return result.success ? { success: true, value: { kind: 'artifact', ...result.data } } : { success: false };
    },
};
