import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import {
  projectHatchPetProgressPlanV1,
  readHatchPetProgressFromToolResultV1,
  type HatchPetProgressPlanV1,
  type HatchPetProgressV1,
} from '@happier-dev/protocol/pets/hatchPetProgressV1';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';

export type HatchPetProgressPresentation = Readonly<{
  plan: HatchPetProgressPlanV1;
  /** Each Hatch pet phase reports a whole snapshot: only the latest one for that pet draws the checklist. */
  visible: boolean;
}>;

function readProgress(tool: ToolCall): HatchPetProgressV1 | null {
  if (tool.state !== 'completed' || tool.result == null) return null;
  // Most commands are not Hatch pet phases: skip parsing unless the snapshot's marker is in the output at all.
  const raw = typeof tool.result === 'string' ? tool.result
    : typeof tool.result === 'object' && 'stdout' in tool.result ? (tool.result as { stdout?: unknown }).stdout : null;
  if (typeof raw !== 'string' || !raw.includes('hatch_pet_progress_v1')) return null;
  return readHatchPetProgressFromToolResultV1(maybeParseJson(tool.result));
}

/**
 * A Hatch pet phase command's progress, from its own final stdout line (the skill's snapshot, parsed by its owner).
 * Hatch pet's checklist is one block in the transcript, so an older snapshot for the same pet draws nothing.
 */
export function readHatchPetProgressPresentation(
  input: Readonly<{
    tool: ToolCall;
    messages: readonly Message[];
  }>,
): HatchPetProgressPresentation | null {
  const progress = readProgress(input.tool);
  if (!progress) return null;
  const own = input.messages.findIndex(
    (message) => message.kind === 'tool-call' && message.tool === input.tool,
  );
  let visible = true;
  for (
    let position = own < 0 ? input.messages.length : own + 1;
    position < input.messages.length;
    position++
  ) {
    const message = input.messages[position]!;
    if (message.kind !== 'tool-call' || message.tool.name !== input.tool.name)
      continue;
    if (readProgress(message.tool)?.petName === progress.petName) {
      visible = false;
      break;
    }
  }
  return { plan: projectHatchPetProgressPlanV1(progress), visible };
}
