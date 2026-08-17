export const AUTOMATION_TEMPLATE_ENCRYPTION_MATERIAL_UNAVAILABLE =
    'automation_template_encryption_material_unavailable' as const;

export class AutomationTemplateEncryptionMaterialUnavailableError extends Error {
    readonly code = AUTOMATION_TEMPLATE_ENCRYPTION_MATERIAL_UNAVAILABLE;

    constructor() {
        super('Automation template encryption material is unavailable');
        this.name = 'AutomationTemplateEncryptionMaterialUnavailableError';
    }
}

export function isAutomationTemplateEncryptionMaterialUnavailableError(
    error: unknown,
): error is AutomationTemplateEncryptionMaterialUnavailableError {
    return error instanceof Error
        && (error as { code?: unknown }).code
            === AUTOMATION_TEMPLATE_ENCRYPTION_MATERIAL_UNAVAILABLE;
}
