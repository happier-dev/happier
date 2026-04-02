export function buildSetupWizardHref() {
    return '/setup/wizard';
}

export function buildMachineSetupWizardHref(params: Readonly<{
    action: 'local' | 'remote';
    step: 'setup_this_computer' | 'remote_ssh_setup';
}>) {
    return `/setup/wizard?action=${encodeURIComponent(params.action)}&step=${encodeURIComponent(params.step)}&scope=machine`;
}

export function buildRelaySetupWizardHref(params: Readonly<{
    step: 'setup_chooser';
}>) {
    return `/setup/wizard?scope=relay&step=${encodeURIComponent(params.step)}`;
}
