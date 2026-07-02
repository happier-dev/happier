import type {
  PluginApiMcpDiscoveryProviderRegistrationV1,
  PluginApiMcpServerRegistrationV1,
  PluginApiNotificationCategoryRegistrationV1,
  PluginApiNotificationChannelRegistrationV1,
  PluginApiRegisterMethodV1,
  PluginApiV1,
  ScmBackendRuntimeRegistration,
} from './api';
import type {
  ScmHostingProviderRuntimeAdapter,
  ScmHostingProviderRuntimeServices,
} from './scm/hostingProvider';

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type LegacyStaticRegistrationKeys = Extract<
  keyof PluginApiV1,
  `${'register'}Provider` | `${'register'}Backend` | `${'register'}Runtime${'Adapter'}`
>;

type _PluginApiMustNotExposeLegacyStaticRegistration = AssertNever<LegacyStaticRegistrationKeys>;

type SiblingRegisterMethods = Readonly<{
  registerScmHostingProvider: PluginApiRegisterMethodV1<Readonly<{ id: string }>>;
}>;

type _PluginApiMustSupportSiblingRegisterMethods = AssertTrue<
  PluginApiV1<SiblingRegisterMethods> extends Readonly<{
    registerScmHostingProvider: PluginApiRegisterMethodV1<Readonly<{ id: string }>>;
  }> ? true : false
>;

type _PluginApiMustExposeNotificationRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerNotificationCategory: PluginApiRegisterMethodV1<PluginApiNotificationCategoryRegistrationV1>;
    registerNotificationChannel: PluginApiRegisterMethodV1<PluginApiNotificationChannelRegistrationV1>;
  }> ? true : false
>;

type DescriptorOnlyRegistrationKeys = 'registerResource' | 'registerUiDescriptor' | 'registerExecutionRunProfile';

type _PluginApiMustNotExposeDescriptorOnlyRegistration = AssertTrue<
  Extract<keyof PluginApiV1, DescriptorOnlyRegistrationKeys> extends never ? true : false
>;

type _PluginApiMustExposeScmBackendRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerScmBackend: PluginApiRegisterMethodV1<ScmBackendRuntimeRegistration>;
  }> ? true : false
>;

type _ScmHostingProviderRuntimeRegistryMustExposeAdapters = AssertTrue<
  Awaited<ReturnType<NonNullable<ScmHostingProviderRuntimeServices['resolveScmHostingProviderRegistry']>>> extends Readonly<{
    getAdapter: (id: string) => ScmHostingProviderRuntimeAdapter | undefined;
  }> ? true : false
>;

type _PluginApiMustExposeMcpRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerMcpServer: PluginApiRegisterMethodV1<PluginApiMcpServerRegistrationV1>;
    registerMcpDiscoveryProvider: PluginApiRegisterMethodV1<PluginApiMcpDiscoveryProviderRegistrationV1>;
  }> ? true : false
>;

type RetiredMcpRegistrationKeys = 'registerMcpBackendClient' | 'registerMcpTool';

type _PluginApiMustNotExposeRetiredMcpRegistration = AssertTrue<
  Extract<keyof PluginApiV1, RetiredMcpRegistrationKeys> extends never ? true : false
>;
