import { logger } from '@/ui/logger';
import { uninstallDaemonService } from './service/installer';

export async function uninstall(): Promise<void> {
  logger.info('Uninstalling Happier CLI daemon service...');
  await uninstallDaemonService();
  logger.info('Daemon service uninstalled');
}
