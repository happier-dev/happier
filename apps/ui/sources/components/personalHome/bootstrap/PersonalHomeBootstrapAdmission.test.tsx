import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { PersonalHomeBootstrapAdmission } from './PersonalHomeBootstrapAdmission';
import { useRequestPersonalHomeBootstrap } from './personalHomeBootstrapRequest';

function Shell() {
    const request = useRequestPersonalHomeBootstrap();
    return <button data-testid="create" disabled={!request} onClick={request ?? undefined} />;
}

function Runtime(props: Readonly<{ children: React.ReactNode; requested: boolean; onSettled: () => void }>) {
    return <div data-testid={props.requested ? 'manual-bootstrap' : 'automatic-bootstrap'}><button data-testid="settle" onClick={props.onSettled} />{props.children}</div>;
}

describe('Personal Home bootstrap admission boundary', () => {
    it('offer constructs no runtime until the person chooses it once', async () => {
        const screen = await renderScreen(<PersonalHomeBootstrapAdmission admission="offer" runtime={Runtime}><Shell /></PersonalHomeBootstrapAdmission>);
        expect(screen.findAllByTestId('automatic-bootstrap')).toHaveLength(0);
        expect(screen.findAllByTestId('manual-bootstrap')).toHaveLength(0);
        await screen.pressByTestIdAsync('create');
        expect(screen.findByTestId('manual-bootstrap')).not.toBeNull();
    });

    it('auto starts the runtime and off never admits creation', async () => {
        const auto = await renderScreen(<PersonalHomeBootstrapAdmission admission="auto" runtime={Runtime}><Shell /></PersonalHomeBootstrapAdmission>);
        expect(auto.findByTestId('automatic-bootstrap')).not.toBeNull();
        const off = await renderScreen(<PersonalHomeBootstrapAdmission admission="off" runtime={Runtime}><Shell /></PersonalHomeBootstrapAdmission>);
        expect(off.findByTestId('create')?.props.disabled).toBe(true);
        expect(off.findAllByTestId('automatic-bootstrap')).toHaveLength(0);
        expect(off.findAllByTestId('manual-bootstrap')).toHaveLength(0);
    });

    it('off keeps existing Home recovery and a completed manual request releases its override', async () => {
        const screen = await renderScreen(<PersonalHomeBootstrapAdmission admission="offer" recoverExistingHome runtime={Runtime}><Shell /></PersonalHomeBootstrapAdmission>);
        await screen.pressByTestIdAsync('create');
        expect(screen.findByTestId('manual-bootstrap')).not.toBeNull();
        await screen.pressByTestIdAsync('settle');
        expect(screen.findAllByTestId('manual-bootstrap')).toHaveLength(0);
        await screen.update(<PersonalHomeBootstrapAdmission admission="off" recoverExistingHome runtime={Runtime}><Shell /></PersonalHomeBootstrapAdmission>);
        expect(screen.findByTestId('automatic-bootstrap')).not.toBeNull();
        expect(screen.findByTestId('create')?.props.disabled).toBe(true);
    });
});
