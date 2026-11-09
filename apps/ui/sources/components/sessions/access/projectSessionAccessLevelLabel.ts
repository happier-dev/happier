import type { EffectiveSessionAccessLevelV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

import { t } from '@/text';

/** One localized presentation owner for effective and editable access levels. */
export function projectSessionAccessLevelLabel(level: EffectiveSessionAccessLevelV1): string {
    return t(`session.access.${level}`);
}
