import { t } from '@/text';
import type { AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';

export const SESSION_CAPABILITIES_CHIP_KEY = 'session-capabilities';
export const SESSION_CAPABILITIES_CHIP_GLYPH = 'stack';

/**
 * A draft that already holds skills (Create a pet's Hatch pet) shows the chip in the row; any other composer keeps it
 * in + as before. `attachedSkills` is the draft's own count, known without a preview.
 */
export function getCapabilitiesActionChipPlacement(params: Readonly<{ scoped?: boolean; attachedSkills?: number }> = {}): AgentInputControlPlacement {
    return { id: params.scoped ? `capabilities:${SESSION_CAPABILITIES_CHIP_KEY}` : 'capabilities', title: t('settingsAgents.capabilities'), icon: SESSION_CAPABILITIES_CHIP_GLYPH,
        ...(params.attachedSkills === undefined ? { defaultPlacement: 'overflow' as const }
            : { defaultPlacement: 'auto' as const, hasContent: params.attachedSkills > 0 }) };
}
