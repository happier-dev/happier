import { ProjectExecutionOutputCopyResultV1Schema } from '@happier-dev/protocol/actions/specs/actionOperations';
import {
  decodeTerminalStreamBytesFrame,
  TerminalStreamReadOkResponseSchema,
  type TerminalStreamReadResponse,
} from '@happier-dev/protocol/terminal/stream';

import type { ActionCliPresentation } from './commandPresentation';

async function writeOutputBytes(bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      process.stdout.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: unknown): void => finish(error);
    process.stdout.once('error', onError);
    try {
      // Await completion for pipes and files without converting to text or
      // adding a newline to the terminal owner's bytes.
      process.stdout.write(bytes, (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

async function presentOutput(output: Extract<TerminalStreamReadResponse, { ok: true }>): Promise<void> {
  for (const frame of output.frames) {
    if (frame.t === 'gap') {
      console.error(
        `Output gap (${frame.reason}): dropped before byte ${frame.droppedBeforeByteOffset}; `
        + `next available byte ${frame.nextAvailableByteOffset}.`,
      );
    } else if (frame.t === 'bytes') {
      await writeOutputBytes(decodeTerminalStreamBytesFrame(frame));
    }
  }
}

export const PROJECT_EXECUTION_OUTPUT_READ_PRESENTATION: ActionCliPresentation = {
  presentSuccess: async (payload, context) => {
    if (context.json) return false;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('Invalid terminal output result');
    }
    // The CLI's canonical success unwrapping removes the outer `ok` field.
    const output = TerminalStreamReadOkResponseSchema.parse({ ok: true, ...payload });
    await presentOutput(output);
    return true;
  },
};

export const PROJECT_EXECUTION_OUTPUT_COPY_PRESENTATION: ActionCliPresentation = {
  presentSuccess: async (payload, context) => {
    if (context.json) return false;
    const result = ProjectExecutionOutputCopyResultV1Schema.parse(payload);
    await presentOutput(result.output);
    return true;
  },
};
