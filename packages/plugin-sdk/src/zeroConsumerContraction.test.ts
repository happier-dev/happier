import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-257:LS0gdGhlIHplcm8tY29uc3VtZXIgcnVudGltZSBlcnJvciBzZXJ2aWNlIGlzIGRlbGV0ZWQgYXQgaXRzIHNvdXJjZSBvd25lci4:aW1wb3J0IHR5cGUgeyBFcnJvclJ1bnRpbWVTZXJ2aWNlVjEgfSBmcm9tICcuL2Vycm9ycy5qcyc7 */
type ErrorRuntimeServiceV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-258:LS0gb3BlcmF0aW9uIGF2YWlsYWJpbGl0eSBpcyB0aGUgb25seSBjYW5vbmljYWwgYXZhaWxhYmlsaXR5IGlkZW50aXR5Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXJ2aWNlQXZhaWxhYmlsaXR5IH0gZnJvbSAnLi9hdmFpbGFiaWxpdHkuanMnOw */
type PluginServiceAvailability = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-259:LS0gdGhlIHNlbGYtY29uc3VtZWQgcmVmZXJlbmNlIGFkYXB0ZXIgc291cmNlIGlzIHJldGlyZWQgd2l0aCBpdHMgdGVzdHMu:aW1wb3J0IHR5cGUgKiBhcyBSZXRpcmVkU2VydmljZUFkYXB0ZXJNb2R1bGUgZnJvbSAnLi90ZXN0aW5nL3NlcnZpY2VBZGFwdGVyLmpzJzs */
type RetiredServiceAdapterModule = never;
declare const RetiredServiceAdapterModule: never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-260:LS0gdGhlIHJldGlyZWQgcnVudGltZSBlcnJvciBzZXJ2aWNlIGlzIG5vdCBwdWJsaWMgcnVudGltZSBBUEku:aW1wb3J0IHR5cGUgeyBFcnJvclJ1bnRpbWVTZXJ2aWNlVjEgYXMgUHVibGljRXJyb3JSdW50aW1lU2VydmljZVYxIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PublicErrorRuntimeServiceV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-261:LS0gdGhlIHJldGlyZWQgYXZhaWxhYmlsaXR5IGFsaWFzIGlzIG5vdCBwdWJsaWMgcnVudGltZSBBUEku:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXJ2aWNlQXZhaWxhYmlsaXR5IGFzIFB1YmxpY1NlcnZpY2VBdmFpbGFiaWxpdHkgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PublicServiceAvailability = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-262:LS0gdGhlIHJldGlyZWQgYWRhcHRlciB0eXBlIGlzIG5vdCBwdWJsaWMgdGVzdGluZyBBUEku:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXJ2aWNlUmVmZXJlbmNlQWRhcHRlciBhcyBQdWJsaWNTZXJ2aWNlUmVmZXJlbmNlQWRhcHRlciB9IGZyb20gJy4vdGVzdGluZy9pbmRleC5qcyc7 */
type PublicServiceReferenceAdapter = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-263:LS0gdGhlIHJldGlyZWQgYWRhcHRlciBvcHRpb25zIGFyZSBub3QgcHVibGljIHRlc3RpbmcgQVBJLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXJ2aWNlUmVmZXJlbmNlQWRhcHRlck9wdGlvbnMgYXMgUHVibGljU2VydmljZVJlZmVyZW5jZUFkYXB0ZXJPcHRpb25zIH0gZnJvbSAnLi90ZXN0aW5nL2luZGV4LmpzJzs */
type PublicServiceReferenceAdapterOptions = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-264:LS0gdGhlIHJldGlyZWQgb3BlcmF0aW9uIGNvbnRleHQgaXMgbm90IHB1YmxpYyB0ZXN0aW5nIEFQSS4:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXJ2aWNlUmVmZXJlbmNlT3BlcmF0aW9uQ29udGV4dCBhcyBQdWJsaWNTZXJ2aWNlUmVmZXJlbmNlT3BlcmF0aW9uQ29udGV4dCB9IGZyb20gJy4vdGVzdGluZy9pbmRleC5qcyc7 */
type PublicServiceReferenceOperationContext = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-265:LS0gdGhlIHJldGlyZWQgYWRhcHRlciBmYWN0b3J5IGlzIG5vdCBwdWJsaWMgdGVzdGluZyBBUEku:aW1wb3J0IHR5cGUgeyBjcmVhdGVQbHVnaW5TZXJ2aWNlUmVmZXJlbmNlQWRhcHRlciBhcyBQdWJsaWNDcmVhdGVQbHVnaW5TZXJ2aWNlUmVmZXJlbmNlQWRhcHRlciB9IGZyb20gJy4vdGVzdGluZy9pbmRleC5qcyc7 */
type PublicCreatePluginServiceReferenceAdapter = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-zeroConsumerContraction-test-ts-266:LS0gcm9vdCBKc29uVmFsdWUgaXMgdGhlIHNvbGUgcHVibGljIHN0cmljdCBKU09OIGlkZW50aXR5Lg:aW1wb3J0IHR5cGUgeyBTdHJpY3RKc29uVmFsdWUgYXMgUmV0aXJlZFN0cmljdEpzb25WYWx1ZSB9IGZyb20gJy4vc2Vzc2lvbnMvaW5kZXguanMnOw */
type RetiredStrictJsonValue = never; /* @sdk-negative-type-case-end */

import type {
    PluginCollectionMutationConflictV1 as ProtocolPluginCollectionMutationConflictV1,
    PluginCollectionMutationErrorV1 as ProtocolPluginCollectionMutationErrorV1,
} from '@happier-dev/protocol';

import type { PluginApi } from './activation.js';
import type { PluginOperationAvailability } from './availability.js';
import type {
    PluginCollectionMutationConflictV1,
    PluginCollectionMutationErrorV1,
} from './collections/index.js';
import type { DefinePluginInput } from './definePlugin.js';
import type { PluginManifest } from './manifest.js';
import type { PluginServices } from './services/index.js';
import type { PluginTestkitRegistrationByFamily } from './testing/types.js';
import * as runtimeApi from './runtime/index.js';
import * as testingApi from './testing/index.js';

type PublicPluginContributes = NonNullable<PluginManifest['contributes']>;

void (undefined as unknown as ErrorRuntimeServiceV1);
void (undefined as unknown as PluginServiceAvailability);
void (undefined as unknown as typeof RetiredServiceAdapterModule);
void (undefined as unknown as PublicErrorRuntimeServiceV1);
void (undefined as unknown as PublicServiceAvailability);
void (undefined as unknown as PublicServiceReferenceAdapter);
void (undefined as unknown as PublicServiceReferenceAdapterOptions);
void (undefined as unknown as PublicServiceReferenceOperationContext);
void (undefined as unknown as PublicCreatePluginServiceReferenceAdapter);
void (undefined as unknown as RetiredStrictJsonValue);

describe('zero-consumer SDK contraction', () => {
    it('removes the superseded registration export and dormant generated actions facade', () => {
        const packageJson = JSON.parse(readFileSync(
            new URL('../package.json', import.meta.url),
            'utf8',
        )) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

        expect(packageJson.exports['./experimental/testing/registration-scope']).toBeUndefined();
        expect(existsSync(new URL('./experimental/testingRegistrationScope.ts', import.meta.url)))
            .toBe(false);
        expect(existsSync(new URL('./generated/actions.ts', import.meta.url))).toBe(false);
    });

    it('deletes the dead timeout service declarations and weaker CLI scheduler at their source owners', () => {
        const timeoutSource = readFileSync(new URL('./timeout.ts', import.meta.url), 'utf8');

        expect(timeoutSource).not.toMatch(/\bTimeoutBudgetV1\b/);
        expect(timeoutSource).not.toMatch(/\bTimeoutRuntimeServiceV1\b/);
        expect(existsSync(new URL(
            '../../../apps/cli/src/plugins/runtime/lifecycle/coalescedScheduler.ts',
            import.meta.url,
        ))).toBe(false);
    });

    it('does not publish an External Sessions synonym for root JsonValue', () => {
        const hookSource = readFileSync(new URL('./externalSessionHooks.ts', import.meta.url), 'utf8');
        expect(hookSource).not.toMatch(/\bStrictJsonValue\b/);
    });

    it('publishes request interception through the canonical public activation and HTTP contracts', () => {
        const httpPublication = readFileSync(new URL('./http/index.public.ts', import.meta.url), 'utf8');
        const testkitTypes = readFileSync(new URL('./testing/types.ts', import.meta.url), 'utf8');

        expectTypeOf<DefinePluginInput>().toHaveProperty('requestInterceptors');
        expectTypeOf<PluginApi>().toHaveProperty('interceptors');
        expectTypeOf<PublicPluginContributes['requestInterceptors']>().not.toEqualTypeOf<undefined>();
        expectTypeOf<PluginTestkitRegistrationByFamily>().toHaveProperty('requestInterceptors');
        expect(testkitTypes).not.toMatch(/\bPluginRegistrationValueByFamily\b/u);
        expect(httpPublication).toMatch(
            /\bPluginInterceptedRequest\b.*\bPluginInterceptorRegistrationApi\b.*\bPluginInterceptorResult\b.*\bPluginRequestInterceptor\b.*\bRequestInterceptorContribution\b/su,
        );
    });

    it('deletes the dormant Plugin UI transport stack in favor of the canonical ui/client owner', () => {
        expect(existsSync(new URL('./ui/hostApiClient.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./ui/bridgeClient.ts', import.meta.url))).toBe(false);

        const uiBarrel = readFileSync(new URL('./ui/index.ts', import.meta.url), 'utf8');
        expect(uiBarrel).not.toMatch(/\.\/hostApiClient\.js/);
        expect(uiBarrel).not.toMatch(/\.\/bridgeClient\.js/);
    });

    it('removes manual UI artifact rows while retaining the generated artifact builder', () => {
        const buildBarrel = readFileSync(new URL('./ui/build/index.ts', import.meta.url), 'utf8');
        const publicBuildBarrel = readFileSync(new URL('./ui/build/index.public.ts', import.meta.url), 'utf8');
        const generatedBuilder = readFileSync(new URL('./ui/build/buildUiArtifacts.ts', import.meta.url), 'utf8');
        const publicContract = readFileSync(new URL('./ui/publicContract.ts', import.meta.url), 'utf8');
        const nativeBundleSource = readFileSync(new URL('./ui/reactNativeBundles.ts', import.meta.url), 'utf8');

        expect(existsSync(new URL('./ui/build/artifactContribution.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./ui/artifacts.ts', import.meta.url))).toBe(false);
        expect(buildBarrel).not.toContain('artifactContribution');
        expect(publicBuildBarrel).not.toContain('artifactContribution');
        expect(publicContract).not.toMatch(/\bPluginUiArtifactContributionV1\b/);
        expect(nativeBundleSource).not.toMatch(/\bPluginReactNativeBundleContributionV1\b/);
        expect(generatedBuilder).toContain('PluginUiArtifactsManifestV1Schema');
    });

    it('uses operation availability as the PluginServices canonical identity', () => {
        expectTypeOf<ReturnType<PluginServices['availability']>>()
            .toEqualTypeOf<PluginOperationAvailability>();
    });

    it('keeps retired values absent from the public runtime and testing barrels', () => {
        expect(runtimeApi).not.toHaveProperty('ErrorRuntimeServiceV1');
        expect(runtimeApi).not.toHaveProperty('PluginServiceAvailability');
        expect(testingApi).not.toHaveProperty('createPluginServiceReferenceAdapter');
    });

    it('publishes one name per collection mutation member instead of a bare synonym of the V1 identity', () => {
        const collectionsSource = readFileSync(new URL('./collections.ts', import.meta.url), 'utf8');
        const collectionsBarrel = readFileSync(new URL('./collections/index.ts', import.meta.url), 'utf8');
        const publicCollections = readFileSync(
            new URL('./collections/index.public.ts', import.meta.url),
            'utf8',
        );

        // The V1 members stay published; only the duplicate unsuffixed synonyms go.
        expectTypeOf<PluginCollectionMutationConflictV1>()
            .toEqualTypeOf<ProtocolPluginCollectionMutationConflictV1>();
        expectTypeOf<PluginCollectionMutationErrorV1>()
            .toEqualTypeOf<ProtocolPluginCollectionMutationErrorV1>();
        for (const source of [collectionsSource, collectionsBarrel, publicCollections]) {
            expect(source).not.toMatch(/\bPluginCollectionMutationConflict\b/u);
            expect(source).not.toMatch(/\bPluginCollectionMutationError\b/u);
        }
    });
});
