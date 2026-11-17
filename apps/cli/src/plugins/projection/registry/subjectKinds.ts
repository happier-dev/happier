import { projectPluginSubjectKindDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/subjectKinds';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

/** Cold declarations reuse their supplying occurrence; invocation remains Action-owned. */
export const subjectKindsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'subjectKinds',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'subjectKinds',
        entriesById: Object.freeze(Object.fromEntries((registry.subjectKinds ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const declaration = projectPluginSubjectKindDeclarationV1({ pluginId: entry.pluginId, pluginVersion: entry.pluginVersion, definition: entry.definition });
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[declaration.id, Object.freeze({ ...declaration,
                ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
