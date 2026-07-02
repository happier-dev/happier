import type {
  ScmHostingProviderRuntimeBasicAuthMaterializer,
  ScmHostingProviderRuntimeRegistration,
  ScmHostingProviderRuntimeTokenMaterializer,
} from '@happier-dev/plugin-sdk';

export type ScmHostingAuthMaterializationRegistry = Readonly<{
  scmHostingProvidersById?: ReadonlyMap<string, Readonly<{
    registration: ScmHostingProviderRuntimeRegistration;
  }>>;
}>;

export type ScmHostingTokenMaterializerCandidate = Readonly<{
  providerId: string;
  materializer: ScmHostingProviderRuntimeTokenMaterializer;
}>;

export type ScmHostingBasicAuthMaterializerCandidate = Readonly<{
  providerId: string;
  materializer: ScmHostingProviderRuntimeBasicAuthMaterializer;
}>;

export function collectScmHostingTokenMaterializerCandidates(
  registry?: ScmHostingAuthMaterializationRegistry,
): readonly ScmHostingTokenMaterializerCandidate[] {
  const candidates: ScmHostingTokenMaterializerCandidate[] = [];
  const seen = new Set<string>();
  for (const [providerId, binding] of registry?.scmHostingProvidersById?.entries() ?? []) {
    const materializer = binding.registration.auth?.tokenMaterializer;
    if (!materializer) continue;
    const key = `${providerId}:${materializer.serviceId}`;
    if (seen.has(key)) continue;
    candidates.push({ providerId, materializer });
    seen.add(key);
  }
  return Object.freeze(candidates);
}

export function collectScmHostingBasicAuthMaterializerCandidates(
  registry?: ScmHostingAuthMaterializationRegistry,
): readonly ScmHostingBasicAuthMaterializerCandidate[] {
  const candidates: ScmHostingBasicAuthMaterializerCandidate[] = [];
  const seen = new Set<string>();
  for (const [providerId, binding] of registry?.scmHostingProvidersById?.entries() ?? []) {
    const materializer = binding.registration.auth?.basicAuthMaterializer;
    if (!materializer) continue;
    const key = `${providerId}:${materializer.serviceId}`;
    if (seen.has(key)) continue;
    candidates.push({ providerId, materializer });
    seen.add(key);
  }
  return Object.freeze(candidates);
}
