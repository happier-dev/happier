/**
 * Uninstallation script for Happier daemon LaunchDaemon
 * 
 * NOTE: This uninstallation method is currently NOT USED since we moved away from
 * system-level daemon installation. See install.ts for the full explanation.
 * 
 * This code is kept for potential future use if we decide to offer system-level 
 * installation/uninstallation as an option.
 */

import { existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '@/ui/logger';

const PLIST_LABEL = 'com.happier-cli.daemon';
const LEGACY_PLIST_LABEL = 'com.happy-cli.daemon';
const plistFileForLabel = (label: string) => `/Library/LaunchDaemons/${label}.plist`;

export async function uninstall(): Promise<void> {
    try {
        const candidates = [plistFileForLabel(PLIST_LABEL), plistFileForLabel(LEGACY_PLIST_LABEL)];
        const existing = candidates.filter((p) => existsSync(p));
        if (existing.length === 0) {
            logger.info('Daemon plist not found. Nothing to uninstall.');
            return;
        }
        
        for (const plistFile of existing) {
            try {
                execSync(`launchctl unload ${plistFile}`, { stdio: 'inherit' });
                logger.info('Daemon stopped successfully');
            } catch {
                // Daemon might not be loaded, continue with removal
                logger.info('Failed to unload daemon (it might not be running)');
            }

            unlinkSync(plistFile);
            logger.info(`Removed daemon plist from ${plistFile}`);
        }
        
        logger.info('Daemon uninstalled successfully');
        
    } catch (error) {
        logger.debug('Failed to uninstall daemon:', error);
        throw error;
    }
}
