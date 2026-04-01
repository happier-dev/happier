export function buildMachineSetupWizardHref(params: Readonly<{
    action: 'local' | 'remote';
    step: 'setup_this_computer' | 'remote_ssh_setup';
}>) {
    return `/setup/wizard?action=${encodeURIComponent(params.action)}&step=${encodeURIComponent(params.step)}&scope=machine`;
}
