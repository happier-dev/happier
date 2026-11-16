import {
    readLiteralCommandExecutedFiles as readWithIo,
    type LiteralCommandFileIo,
    type LiteralCommandLines,
} from '@happier-dev/cli-common/workspaces/literalCommandFiles';

import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { readProjectDefinitionFileBytes } from './nativeDefinitionFiles';

export { listLiteralCommandExecutedFiles, type LiteralCommandFileFactV1, type LiteralCommandLines } from '@happier-dev/cli-common/workspaces/literalCommandFiles';

/** This host's contained checkout reader, bound to the current admitted workspace source. */
const io: LiteralCommandFileIo = {
    readBytes: readProjectDefinitionFileBytes,
    realpath: path => currentWorkspaceSource().realpath(path),
    stat: path => currentWorkspaceSource().stat(path),
};

/** The shared literal-command owner read through this host's checkout boundary. */
export function readLiteralCommandExecutedFiles(root: string, cwd: string, command: LiteralCommandLines,
    options?: Readonly<{ files?: readonly string[] }>): ReturnType<typeof readWithIo> {
    return readWithIo(root, cwd, command, { ...options, io });
}
