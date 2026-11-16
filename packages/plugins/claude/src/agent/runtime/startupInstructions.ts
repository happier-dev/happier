import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';

/** Claude reads the append file at launch; prompt text never belongs in process argv. */
export function materializeClaudeStartupInstructions(instructions: string): Readonly<{
    args: readonly string[];
    requiredFiles: readonly string[];
    cleanup: () => Promise<void>;
}> {
    const path = writeSecureTempTextFileSync({
        prefix: 'happier-claude-startup-instructions',
        suffix: '.txt',
        contents: instructions,
    });
    let cleanupPromise: Promise<void> | undefined;
    return {
        args: ['--append-system-prompt-file', path],
        requiredFiles: [path],
        cleanup: () => cleanupPromise ??= rm(dirname(path), { recursive: true, force: true }),
    };
}
