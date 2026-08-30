import type { SelectionListInputBehavior } from '@/components/ui/selectionList';
import { makePathBrowseInputBehavior } from '@/utils/path/browseInputBehavior';
import {
    isBrowsePathLikeInput,
    type PathTargetPlatform,
} from '@/utils/path/browseSegments';

export type PathSelectionInitialSuggestionMode = 'browse' | 'history';

export function resolvePathSelectionInitialInputValue(params: Readonly<{
    initialValue: string;
    initialSuggestionMode: PathSelectionInitialSuggestionMode;
}>): string {
    return params.initialValue;
}

export function resolvePathSelectionEmptyInputPath(params: Readonly<{
    initialValue: string;
    initialSuggestionMode: PathSelectionInitialSuggestionMode;
    machineHomeDir: string;
}>): string {
    if (params.initialSuggestionMode !== 'history') return params.machineHomeDir;
    const trimmedInitialValue = params.initialValue.trim();
    return trimmedInitialValue.length > 0 ? trimmedInitialValue : params.machineHomeDir;
}

type PathSelectionInputBehaviorOptions = Readonly<{
    targetPlatform: PathTargetPlatform;
    initialSuggestionMode: PathSelectionInitialSuggestionMode;
    inputActivated: boolean;
    initialValue: string;
    machineHomeDir: string;
}>;

export function shouldShowPathSelectionBrowseSuggestions(params: Readonly<{
    inputValue: string;
    targetPlatform: PathTargetPlatform;
    initialSuggestionMode: PathSelectionInitialSuggestionMode;
    inputActivated: boolean;
}>): boolean {
    if (params.initialSuggestionMode === 'history') {
        return params.inputActivated;
    }
    return isBrowsePathLikeInput(params.inputValue, params.targetPlatform);
}

function resolveHistoryBrowseSeed(initialValue: string, machineHomeDir: string): string {
    return resolvePathSelectionEmptyInputPath({
        initialValue,
        initialSuggestionMode: 'history',
        machineHomeDir,
    });
}

function isHistoryPlainInput(
    input: string,
    options: PathSelectionInputBehaviorOptions,
): boolean {
    return options.initialSuggestionMode === 'history'
        && options.inputActivated
        && !isBrowsePathLikeInput(input, options.targetPlatform);
}

export function createPathSelectionInputBehavior(
    options: PathSelectionInputBehaviorOptions,
): SelectionListInputBehavior {
    const pathBehavior = makePathBrowseInputBehavior({ targetPlatform: options.targetPlatform });
    const isInactiveHistory = options.initialSuggestionMode === 'history' && !options.inputActivated;

    return {
        getFilterQueryFromInput: (input) => {
            if (isInactiveHistory) return '';
            if (isHistoryPlainInput(input, options)) return input;
            return pathBehavior.getFilterQueryFromInput?.(input) ?? input;
        },
        getDynamicSectionSeed: (input) => {
            if (isHistoryPlainInput(input, options)) {
                return resolveHistoryBrowseSeed(options.initialValue, options.machineHomeDir);
            }
            return pathBehavior.getDynamicSectionSeed?.(input) ?? input;
        },
        onBackspaceAtEnd: (input) => {
            if (isInactiveHistory || isHistoryPlainInput(input, options)) return null;
            return pathBehavior.onBackspaceAtEnd?.(input) ?? null;
        },
        onBackUp: (input) => {
            if (isInactiveHistory || isHistoryPlainInput(input, options)) return null;
            return pathBehavior.onBackUp?.(input) ?? null;
        },
        shouldSuppressAutocomplete: (input) => {
            if (isInactiveHistory) return true;
            if (isHistoryPlainInput(input, options)) return false;
            return pathBehavior.shouldSuppressAutocomplete?.(input) ?? false;
        },
    };
}
