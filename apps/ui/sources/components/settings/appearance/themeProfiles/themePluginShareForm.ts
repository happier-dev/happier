import { createActionInputForm, type ActionInputFormAccountLifetime } from '@/components/plugins/actions/actionInputForm';
import { THEME_ACTION_IDS, ThemeActionInputSchemas, type ThemeActionInput, type ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import { MachineTargetV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

type ShareInput = ThemeActionInput<typeof THEME_ACTION_IDS.sharePlugin>;
export type ThemePluginShareResult = ThemeActionOutput<typeof THEME_ACTION_IDS.sharePlugin>;
export type ThemePluginShareLabels = Readonly<{ share: string; machine: string; path: string }>;
export type ThemePluginShareExecute = (id: typeof THEME_ACTION_IDS.sharePlugin, input: ShareInput,
    operation?: Readonly<{ signal?: AbortSignal }>) => Promise<ThemePluginShareResult>;

/** Both editor and library share through the same selected-Machine Action form. */
export function createThemePluginShareForm(params: Readonly<{
    refs: ShareInput['refs'];
    serverId: string;
    labels: ThemePluginShareLabels;
    execute: ThemePluginShareExecute;
    accountLifetime?: ActionInputFormAccountLifetime | null;
    signal?: AbortSignal;
    onShared?: (result: ThemePluginShareResult) => void;
}>) {
    return createActionInputForm({
        presentation: { title: params.labels.share, description: null, inputHints: { fields: [
            { path: 'machine', title: params.labels.machine, widget: 'select', required: true, inputType: { hostType: 'machine' } },
            { path: 'path', title: params.labels.path, widget: 'text', required: true },
        ], submitLabel: params.labels.share } },
        accountLifetime: params.accountLifetime,
        signal: params.signal,
        submit: async (candidate, { signal }) => {
            const target = MachineTargetV1Schema.safeParse(candidate.machine);
            if (!target.success || target.data.serverId !== params.serverId) return { ok: false };
            const input = ThemeActionInputSchemas[THEME_ACTION_IDS.sharePlugin].safeParse({
                refs: params.refs, machineId: target.data.machineId, path: candidate.path,
            });
            if (!input.success) return { ok: false };
            let shared: ThemePluginShareResult;
            try {
                shared = await params.execute(THEME_ACTION_IDS.sharePlugin, input.data, { signal });
            } catch (error) {
                return { ok: false, code: readActionErrorCodeV1(error) ?? 'action_failed' };
            }
            params.onShared?.(shared);
            return { ok: true, shared };
        },
    });
}
