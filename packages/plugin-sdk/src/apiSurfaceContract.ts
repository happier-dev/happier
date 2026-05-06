import type {
  PluginApiExecutionRunProfileRegistrationV1,
  PluginApiMcpBackendClientRegistrationV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
  PluginApiMcpServerRegistrationV1,
  PluginApiMcpToolRegistrationV1,
  PluginApiNotificationCategoryRegistrationV1,
  PluginApiNotificationChannelRegistrationV1,
  PluginApiRegisterMethodV1,
  PluginApiV1,
} from './api';

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

type _PluginApiMustExposeExecutionRunProfileRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerExecutionRunProfile: PluginApiRegisterMethodV1<PluginApiExecutionRunProfileRegistrationV1>;
  }> ? true : false
>;

type _PluginApiMustExposeMcpRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerMcpServer: PluginApiRegisterMethodV1<PluginApiMcpServerRegistrationV1>;
    registerMcpBackendClient: PluginApiRegisterMethodV1<PluginApiMcpBackendClientRegistrationV1>;
    registerMcpTool: PluginApiRegisterMethodV1<PluginApiMcpToolRegistrationV1>;
    registerMcpDiscoveryProvider: PluginApiRegisterMethodV1<PluginApiMcpDiscoveryProviderRegistrationV1>;
  }> ? true : false
>;
