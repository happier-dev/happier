import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScmWorkEvidenceAdmission } from '@happier-dev/protocol/scm';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

export const scmRpcOperationContextStorage = new AsyncLocalStorage<Readonly<{
  context: RpcHandlerContext;
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  workAdmissions?: ReadonlyMap<string, ScmWorkEvidenceAdmission['admissions'][number] | null>;
}>>();

/** The receiving SCM owner already selected the requester's filesystem placement. */
export function isScmRpcOperationActive(): boolean {
  return scmRpcOperationContextStorage.getStore() !== undefined;
}
