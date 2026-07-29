import { selectionListTestId } from './_shared';
import type { SelectionListOption } from './_types';

export function resolveSelectionListOptionDomId(params: Readonly<{
    option: Pick<SelectionListOption, 'id' | 'testID'>;
    rootTestID: string | undefined;
    stepId: string;
}>): string {
    return params.option.testID ?? selectionListTestId(
        params.rootTestID,
        params.stepId,
        'option',
        params.option.id,
    );
}
