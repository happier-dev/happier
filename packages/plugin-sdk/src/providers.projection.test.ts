import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ProviderConnectionIdSchema as ProtocolProviderConnectionIdSchema,
  ProviderContributionV1Schema as ProtocolProviderContributionV1Schema,
  ProviderEndpointUrlSyntaxSchema as ProtocolProviderEndpointUrlSyntaxSchema,
  ProviderPublicHeadersV1Schema as ProtocolProviderPublicHeadersV1Schema,
  containsProviderRegisteredSensitiveValue as protocolContainsProviderRegisteredSensitiveValue,
  resolveProviderBindingCompatibilityWithFingerprintV1 as protocolResolveProviderBindingCompatibilityWithFingerprintV1,
  type CapabilitySupport,
  type ProviderApiKeyCredentialRequirementV1 as ProtocolProviderApiKeyCredentialRequirementV1,
  type ProviderCatalogCommandFallbackV1 as ProtocolProviderCatalogCommandFallbackV1,
  type ProviderCatalogDeclarationV1 as ProtocolProviderCatalogDeclarationV1,
  type ProviderCatalogParserV1 as ProtocolProviderCatalogParserV1,
  type ProviderCatalogProbeV1 as ProtocolProviderCatalogProbeV1,
  type ProviderCompatibilityCapabilitiesV1 as ProtocolProviderCompatibilityCapabilitiesV1,
  type ProviderCompatibilityOverrideV1 as ProtocolProviderCompatibilityOverrideV1,
  type ProviderContributionV1 as ProtocolProviderContributionV1,
  type ProviderCredentialDestinationV1 as ProtocolProviderCredentialDestinationV1,
  type ProviderCredentialFormatV1 as ProtocolProviderCredentialFormatV1,
  type ProviderCredentialTransportV1 as ProtocolProviderCredentialTransportV1,
  type ProviderDetectionDescriptorV1 as ProtocolProviderDetectionDescriptorV1,
  type ProviderEndpointTemplateV1 as ProtocolProviderEndpointTemplateV1,
  type ProviderLegacyProfileMigrationDescriptorV1 as ProtocolProviderLegacyProfileMigrationDescriptorV1,
  type ProviderModelLoadDescriptorV1 as ProtocolProviderModelLoadDescriptorV1,
  type ProviderWireProtocol as ProtocolProviderWireProtocol,
} from '@happier-dev/protocol';

import {
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderEndpointUrlSyntaxSchema,
  ProviderPublicHeadersV1Schema,
  containsProviderRegisteredSensitiveValue,
  resolveProviderBindingCompatibilityWithFingerprintV1,
  type ManagedProviderEndpoint,
  type ManagedProviderRuntime,
  type ManagedProviderRuntimeContext,
  type ManagedProviderStartRequest,
  type ProviderApiKeyCredentialRequirementV1,
  type ProviderCapabilitySupport,
  type ProviderCatalogCommandFallbackV1,
  type ProviderCatalogDeclarationV1,
  type ProviderCatalogParserId,
  type ProviderCatalogProbeV1,
  type ProviderCompatibilityCapabilitiesV1,
  type ProviderCompatibilityOverrideV1,
  type ProviderContribution,
  type ProviderCredentialDestinationV1,
  type ProviderCredentialFormatV1,
  type ProviderCredentialTransportV1,
  type ProviderDetectionDescriptorV1,
  type ProviderEndpointTemplateV1,
  type ProviderLegacyProfileMigrationDescriptorV1,
  type ProviderLocalId,
  type ProviderModelLoadDescriptorV1,
  type ProviderWireProtocol,
  type ProvidersRegistrationApi,
} from './providers/index.js';
import type {
  ManagedProviderEndpoint as SourceManagedProviderEndpoint,
  ManagedProviderRuntime as SourceManagedProviderRuntime,
  ManagedProviderRuntimeContext as SourceManagedProviderRuntimeContext,
  ManagedProviderStartRequest as SourceManagedProviderStartRequest,
  ProviderLocalId as SourceProviderLocalId,
  ProvidersRegistrationApi as SourceProvidersRegistrationApi,
} from './providers/projections.js';

describe('Provider public projections', () => {
  it('re-exports canonical Provider validators and utilities by runtime identity', () => {
    expect(ProviderConnectionIdSchema).toBe(ProtocolProviderConnectionIdSchema);
    expect(ProviderContributionV1Schema).toBe(ProtocolProviderContributionV1Schema);
    expect(ProviderEndpointUrlSyntaxSchema).toBe(ProtocolProviderEndpointUrlSyntaxSchema);
    expect(ProviderPublicHeadersV1Schema).toBe(ProtocolProviderPublicHeadersV1Schema);
    expect(containsProviderRegisteredSensitiveValue)
      .toBe(protocolContainsProviderRegisteredSensitiveValue);
    expect(resolveProviderBindingCompatibilityWithFingerprintV1)
      .toBe(protocolResolveProviderBindingCompatibilityWithFingerprintV1);
  });

  it('aliases canonical Provider declaration types without restating their shapes', () => {
    expectTypeOf<ProviderCapabilitySupport>().toEqualTypeOf<CapabilitySupport>();
    expectTypeOf<ProviderApiKeyCredentialRequirementV1>()
      .toEqualTypeOf<ProtocolProviderApiKeyCredentialRequirementV1>();
    expectTypeOf<ProviderCatalogCommandFallbackV1>()
      .toEqualTypeOf<ProtocolProviderCatalogCommandFallbackV1>();
    expectTypeOf<ProviderCatalogDeclarationV1>()
      .toEqualTypeOf<ProtocolProviderCatalogDeclarationV1>();
    expectTypeOf<ProviderCatalogParserId>().toEqualTypeOf<ProtocolProviderCatalogParserV1>();
    expectTypeOf<ProviderCatalogProbeV1>().toEqualTypeOf<ProtocolProviderCatalogProbeV1>();
    expectTypeOf<ProviderCompatibilityCapabilitiesV1>()
      .toEqualTypeOf<ProtocolProviderCompatibilityCapabilitiesV1>();
    expectTypeOf<ProviderCompatibilityOverrideV1>()
      .toEqualTypeOf<ProtocolProviderCompatibilityOverrideV1>();
    expectTypeOf<ProviderContribution>().toEqualTypeOf<ProtocolProviderContributionV1>();
    expectTypeOf<ProviderCredentialDestinationV1>()
      .toEqualTypeOf<ProtocolProviderCredentialDestinationV1>();
    expectTypeOf<ProviderCredentialFormatV1>()
      .toEqualTypeOf<ProtocolProviderCredentialFormatV1>();
    expectTypeOf<ProviderCredentialTransportV1>()
      .toEqualTypeOf<ProtocolProviderCredentialTransportV1>();
    expectTypeOf<ProviderDetectionDescriptorV1>()
      .toEqualTypeOf<ProtocolProviderDetectionDescriptorV1>();
    expectTypeOf<ProviderEndpointTemplateV1>()
      .toEqualTypeOf<ProtocolProviderEndpointTemplateV1>();
    expectTypeOf<ProviderLegacyProfileMigrationDescriptorV1>()
      .toEqualTypeOf<ProtocolProviderLegacyProfileMigrationDescriptorV1>();
    expectTypeOf<ProviderModelLoadDescriptorV1>()
      .toEqualTypeOf<ProtocolProviderModelLoadDescriptorV1>();
    expectTypeOf<ProviderWireProtocol>().toEqualTypeOf<ProtocolProviderWireProtocol>();
  });

  it('projects the SDK-owned managed Provider runtime through the final Provider entrypoint', () => {
    expectTypeOf<ManagedProviderEndpoint>()
      .toEqualTypeOf<SourceManagedProviderEndpoint>();
    expectTypeOf<ManagedProviderRuntime>()
      .toEqualTypeOf<SourceManagedProviderRuntime>();
    expectTypeOf<ManagedProviderRuntimeContext>()
      .toEqualTypeOf<SourceManagedProviderRuntimeContext>();
    expectTypeOf<ManagedProviderStartRequest>()
      .toEqualTypeOf<SourceManagedProviderStartRequest>();
    expectTypeOf<ProviderLocalId>().toEqualTypeOf<SourceProviderLocalId>();
    expectTypeOf<ProvidersRegistrationApi>()
      .toEqualTypeOf<SourceProvidersRegistrationApi>();
  });
});
