import type { MachineRoleStopReason } from '../types';

/** What the daemon's provider-broker owner starts for the registered Machine (see bootstrap runtime). */
export type BrokerRoleApplication = Readonly<{
  accountConnectionIngress?: boolean;
  actionOperationIngress?: boolean;
  close(): Promise<void>;
}>;

export type BrokerRoleContext = Readonly<{
  startApplication: () => Promise<BrokerRoleApplication>;
  /** Advertises (or withdraws) `providerBrokerIngress` on the current Machine transport. */
  setIngressLive: (live: boolean, application?: BrokerRoleApplication) => Promise<void>;
}>;

export type BrokerRoleActivation = Readonly<{
  application: BrokerRoleApplication;
  stop: (reason?: MachineRoleStopReason) => Promise<void>;
}>;

/**
 * `broker` role: the provider-broker application and its `providerBrokerIngress` advertisement.
 * The server routes brokered requests only to Machines that advertise it, so an inactive role is
 * never chosen; the peer carrier's application targets answer nothing while it is off.
 */
export async function activateBrokerRole(ctx: BrokerRoleContext): Promise<BrokerRoleActivation> {
  const application = await ctx.startApplication();
  try {
    await ctx.setIngressLive(true, application);
  } catch (error) {
    await application.close();
    throw error;
  }
  return {
    application,
    stop: async () => {
      try {
        await ctx.setIngressLive(false);
      } finally {
        await application.close();
      }
    },
  };
}
