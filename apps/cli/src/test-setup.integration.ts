import { setup } from './test-setup'

export default async function globalSetup() {
  await setup({ buildMode: 'shared-only' })
}
