import type {
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
