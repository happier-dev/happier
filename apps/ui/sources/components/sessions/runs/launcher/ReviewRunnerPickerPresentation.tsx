import * as React from 'react';
import type { ReviewRunnerPickerProps } from '@happier-dev/plugin-ui/components';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';

export function renderReviewRunnerPicker(input: ReviewRunnerPickerProps): React.ReactNode {
    return <ReviewRunnerPickerPresentation {...input} />;
}

/** One native row presenter for core and contributed Review launchers. */
export function ReviewRunnerPickerPresentation(props: ReviewRunnerPickerProps) {
    const [open, setOpen] = React.useState(false);
    return <>
        <DropdownMenu open={open} onOpenChange={setOpen} selectedId={props.selectedId}
            itemTrigger={{ title: props.title, itemProps: { testID: props.testID } }} items={props.options} onSelect={props.onSelect} />
        {props.children}
        {props.addMember ? <Item title={props.addMember.label} testID={props.testID === undefined
            ? 'review-runner-add-member' : `${props.testID}-add-member`}
            icon={<Icon name="plus" size={ICON_SIZE.sm} />} onPress={props.addMember.onPress} showChevron={false} /> : null}
    </>;
}
