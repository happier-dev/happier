import { AutomationV3SettingsSchema, type AutomationV3Settings } from '../../automations/automationApiV3.js';

export type AutomationSettingsDeclarationOwner = Readonly<{
    read(): Promise<unknown>;
    write(settings: AutomationV3Settings): Promise<unknown>;
}>;

function refuse(errorCode: string) {
    return { ok: false as const, errorCode, error: errorCode };
}

/** Account-scoped Automation policy remains on its server owner, outside private Account preferences. */
export async function executeAutomationSettingDeclaration(input: Readonly<{
    actionId: 'settings.get' | 'settings.set';
    anchor: string;
    field: keyof AutomationV3Settings;
    value?: unknown;
    owner: AutomationSettingsDeclarationOwner;
    signal?: AbortSignal;
    isCurrent(): boolean | Promise<boolean>;
}>) {
    const isCurrent = async () => {
        input.signal?.throwIfAborted();
        const current = await input.isCurrent();
        input.signal?.throwIfAborted();
        return current;
    };
    if (!await isCurrent()) return refuse('setting_not_bound');
    const value = input.actionId === 'settings.set'
        ? AutomationV3SettingsSchema.shape[input.field].safeParse(input.value)
        : undefined;
    if (value && !value.success) return refuse('invalid_setting_value');
    const current = await input.owner.read();
    if (!await isCurrent()) return refuse('setting_not_bound');
    const record = AutomationV3SettingsSchema.parse(current);
    if (input.actionId === 'settings.get') return { anchor: input.anchor, value: record[input.field] };
    if (!value?.success) return refuse('invalid_setting_value');
    const next = AutomationV3SettingsSchema.parse({ ...record, [input.field]: value.data });
    input.signal?.throwIfAborted();
    const updated = await input.owner.write(next);
    if (!await isCurrent()) return refuse('setting_not_bound');
    return { anchor: input.anchor, value: AutomationV3SettingsSchema.parse(updated)[input.field] };
}
