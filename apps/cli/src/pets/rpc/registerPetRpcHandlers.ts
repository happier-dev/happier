import { PET_DAEMON_RPC_METHODS } from '@happier-dev/protocol';
import type { AccountPetCreateRequestV1, AccountPetCreateResponseV1 } from '@happier-dev/protocol';

import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

import { createPetPackageDiscoveryCache } from '../discovery/petPackageDiscoveryCache';
import { createAccountPetViaActiveServer } from '../storage/createAccountPetClient';
import { handleDiscoverPets } from './handleDiscoverPets';
import { handleForgetLocalPetPackage } from './handleForgetLocalPetPackage';
import { handleImportAccountPetPackage, handleImportLocalPetPackage } from './handleImportPetPackage';
import { handleReadPetPreviewAsset } from './handleReadPetAsset';
import { handleValidatePetPackage } from './handleValidatePetPackage';
import { createPetCompanionFeatureGateResolver } from './petCompanionFeatureGate';
import { createPetRpcRateLimiter } from './petRpcRateLimiter';

export function registerPetRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
  resolveCompanionFeatureEnabled?: () => boolean | Promise<boolean>;
}>): void {
  const discoveryCache = createPetPackageDiscoveryCache();
  const rateLimiter = createPetRpcRateLimiter();
  const resolveCompanionFeatureEnabled =
    params.resolveCompanionFeatureEnabled ?? createPetCompanionFeatureGateResolver();
  const companionGate = async () => ({
    companionFeatureEnabled: await resolveCompanionFeatureEnabled(),
    rateLimiter,
  });
  params.rpcHandlerManager.registerHandler(PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES, async (raw) => handleDiscoverPets(raw, {
    discoveryCache,
    ...(await companionGate()),
  }));
  params.rpcHandlerManager.registerHandler(PET_DAEMON_RPC_METHODS.VALIDATE_PACKAGE, async (raw) => handleValidatePetPackage(raw, {
    ...(await companionGate()),
  }));
  params.rpcHandlerManager.registerHandler(PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE, async (raw) => handleImportLocalPetPackage(raw, {
    discoveryCache,
    ...(await companionGate()),
  }));
  params.rpcHandlerManager.registerHandler(PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE, async (raw) => handleImportAccountPetPackage(raw, {
    discoveryCache,
    createAccountPet: params.createAccountPet ?? createAccountPetViaActiveServer,
    ...(await companionGate()),
  }));
  params.rpcHandlerManager.registerHandler(PET_DAEMON_RPC_METHODS.FORGET_LOCAL_PACKAGE, async (raw) => handleForgetLocalPetPackage(raw, {
    discoveryCache,
    ...(await companionGate()),
  }));
  params.rpcHandlerManager.registerHandler(PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET, async (raw) => handleReadPetPreviewAsset(raw, {
    discoveryCache,
    ...(await companionGate()),
  }));
}
