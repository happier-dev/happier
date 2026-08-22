/**
 * Doctor command implementation
 * 
 * Provides comprehensive diagnostics and troubleshooting information
 * for Happier CLI including configuration, daemon status, logs, and links
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readSettings, readStoredCredentials } from '@/persistence'
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient'
import { findRunawayHappyProcesses, findAllHappyProcesses } from '@/daemon/doctor'
import { readDaemonState } from '@/persistence'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import packageJson from '../../package.json'
import { buildDoctorSnapshot, type DoctorSnapshot } from '@/ui/doctorSnapshot'
import {
    buildDoctorRuntimeDiagnostics,
    formatDoctorRuntimeLabel,
    formatDoctorSpawnPathLabel,
} from '@/ui/doctorRuntimeDiagnostics'
import { renderDoctorHappierRuntimeInventory } from '@/ui/doctorRuntimeInventory'
import {
    redactDaemonStateForDisplay,
    redactDoctorDiagnosticText,
    redactDoctorProcessCommandForDisplay,
    redactSettingsForDisplay,
} from '@/ui/doctorRedaction'

export { redactDaemonStateForDisplay } from '@/ui/doctorRedaction'

export function maskValue(value: string): string;
export function maskValue(value: string | undefined): string | undefined;
export function maskValue(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (value.trim() === '') return '<empty>';

    // Treat ${VAR} templates as safe to display (they do not contain secrets themselves).
    if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)) return value;

    // For templates with default values, preserve the template structure but mask the fallback.
    // Example: ${OPENAI_API_KEY:-sk-...} -> ${OPENAI_API_KEY:-<N chars>}
    const matchWithFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*)(:-|:=)(.*)\}$/);
    if (matchWithFallback) {
        const [, sourceVar, operator, fallback] = matchWithFallback;
        if (fallback === '') return `\${${sourceVar}${operator}}`;
        return `\${${sourceVar}${operator}${maskValue(fallback)}}`;
    }

    return `<${value.length} chars>`;
}

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, any> {
    return {
        PWD: process.env.PWD,
        HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
        HAPPIER_SERVER_URL: process.env.HAPPIER_SERVER_URL,
        HAPPIER_PROJECT_ROOT: process.env.HAPPIER_PROJECT_ROOT,
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING,
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG,
        workingDirectory: process.cwd(),
        processArgv: process.argv,
        happyDir: configuration?.happyHomeDir,
        serverUrl: configuration?.serverUrl,
        logsDir: configuration?.logsDir,
        processPid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        user: process.env.USER,
        home: process.env.HOME,
        shell: process.env.SHELL,
        terminal: process.env.TERM,
    };
}

function getLogFiles(logDir: string): { file: string, path: string, modified: Date }[] {
    if (!existsSync(logDir)) {
        return [];
    }

    try {
        return readdirSync(logDir)
            .filter(file => file.endsWith('.log'))
            .map(file => {
                const path = join(logDir, file);
                const stats = statSync(path);
                return { file, path, modified: stats.mtime };
            })
            .sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } catch {
        return [];
    }
}

/**
 * Run doctor command specifically for daemon diagnostics
 */
export async function runDoctorDaemon(): Promise<void> {
    return runDoctorCommand('daemon');
}

export function shouldShowGlobalProcessInventory(filter: 'all' | 'daemon'): boolean {
    return filter === 'all';
}

export async function runDoctorCommand(filter?: 'all' | 'daemon'): Promise<void> {
    // Default to 'all' if no filter specified
    if (!filter) {
        filter = 'all';
    }
    
    console.log(chalk.bold.cyan('\n🩺 Happier CLI Doctor\n'));

    // For 'all' filter, show everything. For 'daemon', only show daemon-related info
    if (filter === 'all') {
        let snapshot: DoctorSnapshot | null = null;
        try {
            snapshot = await buildDoctorSnapshot();
        } catch {
            snapshot = null;
        }

        // Version and basic info
        console.log(chalk.bold('📋 Basic Information'));
        console.log(`Happier CLI Version: ${chalk.green(packageJson.version)}`);
        console.log(`Platform: ${chalk.green(process.platform)} ${process.arch}`);
        const runtimeDiagnostics = buildDoctorRuntimeDiagnostics();
        console.log(`Runtime: ${chalk.green(formatDoctorRuntimeLabel(runtimeDiagnostics))}`);
        if (runtimeDiagnostics.runtime !== 'node' && runtimeDiagnostics.nodeCompatibilityVersion) {
            console.log(`Node compatibility: ${chalk.green(runtimeDiagnostics.nodeCompatibilityVersion)}`);
        }
        console.log('');

        // Daemon spawn diagnostics
        console.log(chalk.bold('🔧 Daemon Spawn Diagnostics'));
        console.log(`Project Root: ${chalk.blue(runtimeDiagnostics.projectRoot)}`);
        console.log(`Wrapper Script: ${chalk.blue(formatDoctorSpawnPathLabel(runtimeDiagnostics.wrapperPath))}`);
        console.log(`CLI Entrypoint: ${chalk.blue(formatDoctorSpawnPathLabel(runtimeDiagnostics.cliEntrypointPath))}`);
        if (runtimeDiagnostics.wrapperExists !== null) {
            console.log(`Wrapper Exists: ${runtimeDiagnostics.wrapperExists ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);
        }
        if (runtimeDiagnostics.cliEntrypointExists !== null) {
            console.log(`CLI Exists: ${runtimeDiagnostics.cliEntrypointExists ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);
        }
        console.log('');

        // Configuration
        console.log(chalk.bold('⚙️  Configuration'));
        console.log(`Happier Home: ${chalk.blue(configuration.happyHomeDir)}`);
        console.log(`Relay URL: ${chalk.blue(redactDoctorDiagnosticText(configuration.serverUrl))}`);
        console.log(`Logs Dir: ${chalk.blue(configuration.logsDir)}`);

        // Environment
        console.log(chalk.bold('\n🌍 Environment Variables'));
        const env = getEnvironmentInfo();
        console.log(`HAPPIER_HOME_DIR: ${env.HAPPIER_HOME_DIR ? chalk.green(redactDoctorDiagnosticText(env.HAPPIER_HOME_DIR)) : chalk.gray('not set')}`);
        console.log(`HAPPIER_SERVER_URL: ${env.HAPPIER_SERVER_URL ? chalk.green(redactDoctorDiagnosticText(env.HAPPIER_SERVER_URL)) : chalk.gray('not set')}`);
        console.log(`DANGEROUSLY_LOG_TO_SERVER: ${env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING ? chalk.yellow('ENABLED') : chalk.gray('not set')}`);
        console.log(`DEBUG: ${env.DEBUG ? chalk.green(redactDoctorDiagnosticText(env.DEBUG)) : chalk.gray('not set')}`);
        console.log(`NODE_ENV: ${env.NODE_ENV ? chalk.green(redactDoctorDiagnosticText(env.NODE_ENV)) : chalk.gray('not set')}`);

        // Connections summary (server/account/server profiles)
        if (snapshot) {
            console.log(chalk.bold('\n🧭 Connections'));
            console.log(`Resolved Relay ID: ${chalk.green(snapshot.server.activeServerId)}`);
            console.log(`Resolved Relay URL: ${chalk.blue(redactDoctorDiagnosticText(snapshot.server.serverUrl))}`);
            if (snapshot.accountId) {
                console.log(`Account: ${chalk.green(snapshot.accountId)}`);
            } else {
                console.log(`Account: ${chalk.gray('(unknown)')}`);
            }

            const settingsActive = snapshot.settings.activeServerId;
            if (settingsActive && settingsActive !== snapshot.server.activeServerId) {
                console.log(chalk.yellow(`⚠️  settings.json activeServerId (${settingsActive}) differs from resolved server id (${snapshot.server.activeServerId})`));
            }

            if (snapshot.settings.servers.length > 0) {
                console.log('Configured relays:');
                for (const server of snapshot.settings.servers.slice(0, 12)) {
                    console.log(`  - ${server.name} (${server.id}) → ${redactDoctorDiagnosticText(server.serverUrl)}`);
                }
                if (snapshot.settings.servers.length > 12) {
                    console.log(`  … and ${snapshot.settings.servers.length - 12} more`);
                }
            } else {
                console.log(`Configured relays: ${chalk.gray('(none)')}`);
            }

        }

        // Settings
        try {
            const settings = await readSettings();
            console.log(chalk.bold('\n📄 Settings (settings.json):'));
            console.log(chalk.gray(JSON.stringify(redactSettingsForDisplay(settings), null, 2)));
        } catch (error) {
            console.log(chalk.bold('\n📄 Settings:'));
            console.log(chalk.red('❌ Failed to read settings'));
        }

        // Authentication status
        console.log(chalk.bold('\n🔐 Authentication'));
        try {
            const credentials = await readStoredCredentials();
            if (credentials) {
                console.log(chalk.green('✓ Authenticated (credentials found)'));
                if (snapshot?.accountId) {
                    console.log(`  Account: ${chalk.green(snapshot.accountId)}`);
                }
            } else {
                console.log(chalk.yellow('⚠️  Not authenticated (no credentials)'));
            }
        } catch (error) {
            console.log(chalk.red('❌ Error reading credentials'));
        }

        if (snapshot) {
            const runtimeInventory = renderDoctorHappierRuntimeInventory(snapshot);
            if (runtimeInventory.trim()) {
                console.log(`\n${runtimeInventory}`);
            }
        }
    }

    // Daemon status - shown for both 'all' and 'daemon' filters
    console.log(chalk.bold('\n🤖 Daemon Status'));
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        const state = await readDaemonState();

        if (isRunning && state) {
            console.log(chalk.green('✓ Daemon is running'));
            console.log(`  PID: ${state.pid}`);
            console.log(`  Started: ${new Date(state.startedAt).toLocaleString()}`);
            console.log(`  CLI Version: ${state.startedWithCliVersion}`);
            if (state.httpPort) {
                console.log(`  HTTP Port: ${state.httpPort}`);
            }
        } else if (state && !isRunning) {
            console.log(chalk.yellow('⚠️  Daemon state exists but process not running (stale)'));
        } else {
            console.log(chalk.red('❌ Daemon is not running'));
        }

        // Show daemon state file
        if (state) {
            console.log(chalk.bold('\n📄 Daemon State:'));
            console.log(chalk.blue(`Location: ${configuration.daemonStateFile}`));
            console.log(chalk.gray(JSON.stringify(redactDaemonStateForDisplay(state), null, 2)));
        }

        if (shouldShowGlobalProcessInventory(filter)) {
            // All Happier processes
            const allProcesses = await findAllHappyProcesses();
            if (allProcesses.length > 0) {
                console.log(chalk.bold('\n🔍 All Happier CLI Processes'));

                // Group by type
                const grouped = allProcesses.reduce((groups, process) => {
                    if (!groups[process.type]) groups[process.type] = [];
                    groups[process.type].push(process);
                    return groups;
                }, {} as Record<string, typeof allProcesses>);

                // Display each group
                Object.entries(grouped).forEach(([type, processes]) => {
                    const typeLabels: Record<string, string> = {
                        'current': '📍 Current Process',
                        'daemon': '🤖 Daemon',
                        'daemon-version-check': '🔍 Daemon Version Check (stuck)',
                        'daemon-spawned-session': '🔗 Daemon-Spawned Sessions',
                        'user-session': '👤 User Sessions',
                        'dev-daemon': '🛠️  Dev Daemon',
                        'dev-daemon-version-check': '🛠️  Dev Daemon Version Check (stuck)',
                        'dev-session': '🛠️  Dev Sessions',
                        'dev-doctor': '🛠️  Dev Doctor',
                        'dev-related': '🛠️  Dev Related',
                        'doctor': '🩺 Doctor',
                        'unknown': '❓ Unknown'
                    };

                    console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
                    processes.forEach(({ pid, command }) => {
                        const color = type === 'current' ? chalk.green :
                            type.startsWith('dev') ? chalk.cyan :
                                type.includes('daemon') ? chalk.blue : chalk.gray;
                        console.log(`  ${color(`PID ${pid}`)}: ${chalk.gray(redactDoctorProcessCommandForDisplay(command))}`);
                    });
                });
            } else {
                console.log(chalk.red('❌ No happier processes found'));
            }

            if (allProcesses.length > 1) { // More than just current process
                console.log(chalk.bold('\n💡 Process Management'));
                console.log(chalk.gray('To clean up runaway processes: happier doctor clean'));
            }
        }
    } catch (error) {
        console.log(chalk.red('❌ Error checking daemon status'));
    }

    // Log files - only show for 'all' filter
    if (filter === 'all') {
        console.log(chalk.bold('\n📝 Log Files'));

        // Get ALL log files
        const allLogs = getLogFiles(configuration.logsDir);
        
        if (allLogs.length > 0) {
            // Separate daemon and regular logs
            const daemonLogs = allLogs.filter(({ file }) => file.includes('daemon'));
            const regularLogs = allLogs.filter(({ file }) => !file.includes('daemon'));

            // Show regular logs (max 10)
            if (regularLogs.length > 0) {
                console.log(chalk.blue('\nRecent Logs:'));
                const logsToShow = regularLogs.slice(0, 10);
                logsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (regularLogs.length > 10) {
                    console.log(chalk.gray(`  ... and ${regularLogs.length - 10} more log files`));
                }
            }

            // Show daemon logs (max 5)
            if (daemonLogs.length > 0) {
                console.log(chalk.blue('\nDaemon Logs:'));
                const daemonLogsToShow = daemonLogs.slice(0, 5);
                daemonLogsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (daemonLogs.length > 5) {
                    console.log(chalk.gray(`  ... and ${daemonLogs.length - 5} more daemon log files`));
                }
            } else {
                console.log(chalk.yellow('\nNo daemon log files found'));
            }
        } else {
            console.log(chalk.yellow('No log files found'));
        }

        // Support and bug reports
        console.log(chalk.bold('\n🐛 Support & Bug Reports'));
        console.log(`Report issues: ${chalk.blue('https://github.com/happier-dev/happier/issues')}`);
        console.log(`Documentation: ${chalk.blue('https://app.happier.dev')}`);
    }

    console.log(chalk.green('\n✅ Doctor diagnosis complete!\n'));
}
