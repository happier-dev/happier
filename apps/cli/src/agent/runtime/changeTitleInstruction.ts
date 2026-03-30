import {
  CHANGE_TITLE_INSTRUCTION_V1,
  buildChangeTitleInstructionV1,
  shouldAppendChangeTitleInstructionV1,
  type ChangeTitleInstructionV1Options,
} from '@happier-dev/protocol';

export type ChangeTitleInstructionOptions = ChangeTitleInstructionV1Options;

export const shouldAppendChangeTitleInstruction = shouldAppendChangeTitleInstructionV1;

export const buildChangeTitleInstruction = buildChangeTitleInstructionV1;

export const CHANGE_TITLE_INSTRUCTION = CHANGE_TITLE_INSTRUCTION_V1;
