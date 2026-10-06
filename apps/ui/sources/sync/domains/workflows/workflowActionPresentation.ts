import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { t, type TranslationKeyNoParams } from '@/text';

/** UI names for catalog declarations that use machine ids. Never infer a title from an id. */
const ACTION_TITLE_KEYS = {
    'artifact.create': 'workflows.actionTitles.artifactCreate',
    'artifact.get': 'workflows.actionTitles.artifactGet',
    'artifact.list': 'workflows.actionTitles.artifactList',
    'artifact.update': 'workflows.actionTitles.artifactUpdate',
    'artifact.delete': 'workflows.actionTitles.artifactDelete',
    'artifact.publish_from_file': 'workflows.actionTitles.artifactPublish',
    'artifact.revisions.list': 'workflows.actionTitles.artifactRevisions',
    'artifact.revisions.restore': 'workflows.actionTitles.artifactRestore',
    'artifact.storage.usage': 'workflows.actionTitles.artifactUsage',
    'artifact.public_link.create': 'workflows.actionTitles.artifactShare',
    'artifact.public_link.list': 'workflows.actionTitles.artifactLinks',
    'artifact.public_link.revoke': 'workflows.actionTitles.artifactRevoke',
    'artifact.public_link.audit': 'workflows.actionTitles.artifactAudit',
    'session.role.set': 'workflows.actionTitles.sessionRole',
    'session.roles.override.set': 'workflows.actionTitles.sessionRoleOverride',
    'session.roles.override.clear': 'workflows.actionTitles.sessionRoleClear',
    'session.roles.add': 'workflows.actionTitles.sessionRoleAdd',
    'session.roles.remove': 'workflows.actionTitles.sessionRoleRemove',
    'session.notes.set': 'workflows.actionTitles.sessionNotes',
    'session.roles.apply_to_reports': 'workflows.actionTitles.sessionRolesApply',
    'roles.list': 'workflows.actionTitles.roleList',
    'roles.get': 'workflows.actionTitles.roleGet',
    'roles.create': 'workflows.actionTitles.roleCreate',
    'roles.update': 'workflows.actionTitles.roleUpdate',
    'roles.delete': 'workflows.actionTitles.roleDelete',
    'roles.override.set': 'workflows.actionTitles.roleOverride',
    'roles.override.reset': 'workflows.actionTitles.roleReset',
    'widgets.catalog.list': 'workflows.actionTitles.widgetCatalog',
    'widgets.instance.list': 'workflows.actionTitles.widgetInstances',
    'widgets.instance.add': 'workflows.actionTitles.widgetAdd',
    'widgets.instance.remove': 'workflows.actionTitles.widgetRemove',
    'widgets.instance.move': 'workflows.actionTitles.widgetMove',
    'widgets.instance.rename': 'workflows.actionTitles.widgetRename',
    'widgets.instance.width.set': 'workflows.actionTitles.widgetWidth',
    'widgets.instance.frame.set': 'workflows.actionTitles.widgetFrame',
    'widgets.instance.inputs.get': 'workflows.actionTitles.widgetInputs',
    'widgets.instance.inputs.validate': 'workflows.actionTitles.widgetValidate',
    'widgets.instance.inputs.set': 'workflows.actionTitles.widgetSetInputs',
    'widgets.instance.inputs.reset': 'workflows.actionTitles.widgetResetInputs',
    'widgets.area.layout.get': 'workflows.actionTitles.widgetLayout',
    'widgets.area.layout.update': 'workflows.actionTitles.widgetUpdateLayout',
    'widgets.definition.list': 'workflows.actionTitles.widgetDefinitions',
    'widgets.definition.get': 'workflows.actionTitles.widgetDefinition',
    'widgets.definition.create': 'workflows.actionTitles.widgetCreate',
    'widgets.definition.update': 'workflows.actionTitles.widgetUpdate',
    'widgets.definition.duplicate': 'workflows.actionTitles.widgetDuplicate',
    'widgets.definition.delete': 'workflows.actionTitles.widgetDelete',
    'widgets.definition.saveFromSession': 'workflows.actionTitles.widgetSave',
} as const satisfies Partial<Record<ActionId, TranslationKeyNoParams>>;

/** Shared by the picker, block headings and reference labels. Plugin titles are already localized. */
export function resolveWorkflowActionTitle(actionId: string, spec: Pick<ActionSpec, 'title'> | null): string {
    if (Object.hasOwn(ACTION_TITLE_KEYS, actionId)) {
        return t(ACTION_TITLE_KEYS[actionId as keyof typeof ACTION_TITLE_KEYS]);
    }
    const title = spec?.title.trim();
    return title && title !== actionId && title !== actionId.split('.').join(' ')
        ? title
        : t('workflows.page.blocks.menuAction');
}
