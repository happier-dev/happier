import type {
  ScmHostingProviderRuntimeBasicAuthMaterializer,
  ScmHostingProviderRuntimeBasicAuthMaterializerRequest,
  ScmHostingProviderRuntimeBasicAuthMaterializerResult,
  ScmHostingProviderRuntimeTokenMaterializer,
  ScmHostingProviderRuntimeTokenMaterializerRequest,
  ScmHostingProviderRuntimeTokenMaterializerResult,
} from '@happier-dev/plugin-sdk';

export type ScmHostingTokenMaterializationRequest =
  ScmHostingProviderRuntimeTokenMaterializerRequest;
export type ScmHostingTokenMaterializationResult =
  ScmHostingProviderRuntimeTokenMaterializerResult;
export type ScmHostingTokenMaterializationMissingReason =
  Extract<ScmHostingTokenMaterializationResult, { kind: 'missing' }>['reason'];
export type ScmHostingTokenMaterializer =
  ScmHostingProviderRuntimeTokenMaterializer;

export type ScmHostingBasicAuthMaterializationRequest =
  ScmHostingProviderRuntimeBasicAuthMaterializerRequest;
export type ScmHostingBasicAuthMaterializationResult =
  ScmHostingProviderRuntimeBasicAuthMaterializerResult;
export type ScmHostingBasicAuthMaterializationMissingReason =
  Extract<ScmHostingBasicAuthMaterializationResult, { kind: 'missing' }>['reason'];
export type ScmHostingBasicAuthMaterializer =
  ScmHostingProviderRuntimeBasicAuthMaterializer;
