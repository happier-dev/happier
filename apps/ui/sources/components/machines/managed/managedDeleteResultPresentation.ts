import { ManagedDeleteTailnetWarningV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

import { t } from '@/text';

export function presentManagedDeleteWarning(value: unknown) {
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'accepted' || !('warning' in value)) return null;
    const parsed = ManagedDeleteTailnetWarningV1Schema.safeParse(value.warning);
    if (!parsed.success) return null;
    const warning = parsed.data;
    return {
        code: warning.code,
        title: t('inbox.actionOperations.warning.tailnetLogoutTitle'),
        description: t('inbox.actionOperations.warning.tailnetLogoutDescription', { node: warning.node }),
        message: warning.node,
    };
}
