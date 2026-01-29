import { asRecord } from './_shared';
import {
    normalizeDeleteAliases,
    normalizeEditAliases,
    normalizeFilePathAliases,
    normalizeFilePathFromLocations,
    normalizeFromAcpItems,
    normalizeWriteAliases,
} from './filePaths';
import { normalizeDiffAliases, normalizePatchFromUnifiedDiff } from './patch';
import { normalizeTodoInputForRendering } from './todos';

export function normalizeToolInputForRendering(params: {
    toolName: string;
    canonicalToolName: string;
    input: unknown;
}): unknown {
    const canonicalLower = params.canonicalToolName.toLowerCase();
    let nextInput: unknown = params.input;

    const inputRecord = asRecord(nextInput);
    if (inputRecord) {
        nextInput =
            normalizeFilePathFromLocations(inputRecord) ??
            normalizeFromAcpItems(inputRecord, { toolNameLower: canonicalLower }) ??
            inputRecord;

        const inputRecord2 = asRecord(nextInput) ?? inputRecord;

        if (canonicalLower === 'patch') {
            nextInput = normalizePatchFromUnifiedDiff(inputRecord2) ?? inputRecord2;
        }

        if (canonicalLower === 'edit') {
            nextInput = normalizeEditAliases(inputRecord2) ?? inputRecord2;
        } else if (canonicalLower === 'write') {
            nextInput = normalizeWriteAliases(inputRecord2) ?? inputRecord2;
        } else if (canonicalLower === 'todowrite') {
            nextInput = normalizeTodoInputForRendering(inputRecord2) ?? inputRecord2;
        } else if (canonicalLower === 'delete') {
            nextInput = normalizeDeleteAliases(inputRecord2) ?? inputRecord2;
        } else if (canonicalLower === 'read') {
            nextInput = normalizeFilePathAliases(inputRecord2) ?? inputRecord2;
        }

        if (params.canonicalToolName === 'Diff') {
            nextInput = normalizeDiffAliases(asRecord(nextInput) ?? inputRecord2) ?? nextInput;
        }
    }

    return nextInput;
}

