import * as React from 'react';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { omitBlankSoftwareInputs, SoftwareInputFields } from '@/components/store/StoreSoftwareInputs';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';
import { MachineSetupReviewFooter } from './MachineSetupPlanReview';
import { readMachineSetupRecipeInputState } from './machineSetupRecipeInputs';

/** The existing Software Action field renderer edits each selected recipe's own inputs. */
export function MachineSetupRecipeInputs(props: Readonly<{
    setup: MachineSetupV1;
    projection: PluginUiProjectionModel | null;
    onChange: (setup: MachineSetupV1) => void;
    testID: string;
    scope?: ServerAccountScope | null;
}>) {
    const localize = usePluginLocalizedTextResolver({ projection: props.projection });
    const state = readMachineSetupRecipeInputState(props.setup, props.projection);
    const pickerContext = React.useMemo(() => props.scope ? { serverId: props.scope.serverId } : undefined, [props.scope?.serverId]);
    return <>{state.rows.filter(row => row.fields.length > 0).map(row => <ItemGroup key={row.index}
        title={localize(row.recipe.pluginId, row.recipe.definition.title)}>
        <SectionContentRow><SoftwareInputFields fields={row.fields} draft={row.input} testID={`${props.testID}.${row.index}`}
            pickerContext={pickerContext}
            onPatch={patch => props.onChange({ ...props.setup, items: props.setup.items?.map((item, index) =>
                index !== row.index || item.kind === 'app' ? item : { ...item, selection: { ...item.selection,
                    inputs: omitBlankSoftwareInputs({ ...row.input, ...patch }) ?? {},
                } }) })} /></SectionContentRow>
    </ItemGroup>)}</>;
}

type ReviewParams = Readonly<{ setup: MachineSetupV1; context: ActionExecutorContext; isCurrent: () => boolean }>;

/** Required inputs settle before effects Plan. No new preset parameters, defaults or declaration reader. */
export async function reviewMachineSetupRecipeInputs(params: ReviewParams): Promise<MachineSetupV1 | null> {
    if (!params.isCurrent() || params.context.signal?.aborted) return null;
    const { serverId, expectedAccountId } = params.context;
    const scope = typeof serverId === 'string' && typeof expectedAccountId === 'string' ? { serverId, accountId: expectedAccountId } : null;
    const projection = readCurrentAppShellPluginUiProjection(scope ? { scope, declarationsOnly: true } : undefined);
    if (readMachineSetupRecipeInputState(params.setup, projection).valid) return params.setup;
    return new Promise(resolve => {
        const finish = (setup: MachineSetupV1 | null) => {
            params.context.signal?.removeEventListener('abort', abort);
            resolve(params.isCurrent() && !params.context.signal?.aborted ? setup : null);
        };
        const abort = () => { Modal.hide(id); finish(null); };
        const id = Modal.show({ component: MachineSetupRecipeInputReview,
            props: { setup: params.setup, projection, scope, onReviewed: finish },
            onRequestClose: () => finish(null), onHostUnmount: () => finish(null),
        });
        params.context.signal?.addEventListener('abort', abort, { once: true });
    });
}

function MachineSetupRecipeInputReview(props: CustomModalInjectedProps & Readonly<{
    setup: MachineSetupV1; projection: PluginUiProjectionModel | null; scope: ServerAccountScope | null;
    onReviewed: (setup: MachineSetupV1 | null) => void;
}>) {
    const [setup, setSetup] = React.useState(props.setup);
    const state = readMachineSetupRecipeInputState(setup, props.projection);
    const missing = state.rows.find(row => !row.valid)?.missing;
    const footer = React.useMemo(() => <MachineSetupReviewFooter cancelTestID="machine-setup-inputs.cancel"
        onCancel={() => { props.onReviewed(null); props.onClose(); }} primary={{
            testID: 'machine-setup-inputs.confirm', label: t('capabilities.store.appPage.review'), disabled: !state.valid,
            disabledReason: missing ? t('session.actionsDraft.validation.requiredField', { field: missing })
                : t('machinePresets.setup.recipeInputsInvalid'),
            onPress: () => { if (state.valid) { props.onReviewed(setup); props.onClose(); } },
        }} />, [missing, props.onClose, props.onReviewed, setup, state.valid]);
    const chrome = React.useMemo(() => ({ kind: 'card' as const, title: t('machinePresets.setup.title'), footer,
        phonePresentation: 'fullscreen' as const, dimensions: { size: 'md' as const, maxHeightRatio: 0.84 } }), [footer]);
    useModalCardChrome(props.setChrome, chrome);
    return <ItemList presentation="grouped" keyboardShouldPersistTaps="handled">
        <MachineSetupRecipeInputs setup={setup} projection={props.projection} scope={props.scope} onChange={setSetup} testID="machine-setup-inputs" />
    </ItemList>;
}
