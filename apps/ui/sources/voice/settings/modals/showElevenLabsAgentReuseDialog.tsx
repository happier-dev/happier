import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';

export type ElevenLabsAgentReuseDecision = 'create_new' | 'update_existing' | 'cancel';

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    width: 300,
    overflow: 'hidden',
    shadowColor: theme.colors.shadow.color,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 16,
    alignItems: 'center',
  },
  title: {
    fontSize: 17,
    textAlign: 'center',
    color: theme.colors.text,
    marginBottom: 4,
  },
  message: {
    fontSize: 13,
    textAlign: 'center',
    color: theme.colors.text,
    marginTop: 4,
    lineHeight: 18,
  },
  buttonContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  buttonRow: {
    flexDirection: 'row',
  },
  button: {
    flex: 1,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: {
    backgroundColor: theme.colors.divider,
  },
  separatorVertical: {
    width: 1,
    backgroundColor: theme.colors.divider,
  },
  separatorHorizontal: {
    height: 1,
    backgroundColor: theme.colors.divider,
  },
  buttonText: {
    fontSize: 17,
    color: theme.colors.textLink,
  },
  primaryText: {
    color: theme.colors.text,
  },
  cancelText: {
    fontWeight: '400',
  },
}));

type DialogProps = Readonly<{
  title: string;
  message: string;
  onResolve: (decision: ElevenLabsAgentReuseDecision) => void;
  onClose: () => void;
}>;

const ElevenLabsAgentReuseDialog: React.FC<DialogProps> = ({ title, message, onResolve, onClose }) => {
  useUnistyles();
  const styles = stylesheet;

  const press = (decision: ElevenLabsAgentReuseDecision) => {
    onResolve(decision);
    onClose();
  };

  // Layout matches the native/web alert modal behavior: for 3 buttons, button[1] is the primary bottom action.
  const buttons: ReadonlyArray<{ text: string; decision: ElevenLabsAgentReuseDecision; style: 'default' | 'cancel' }> = [
    { text: 'Create new', decision: 'create_new', style: 'default' },
    { text: 'Update existing', decision: 'update_existing', style: 'default' },
    { text: 'Cancel', decision: 'cancel', style: 'cancel' },
  ];

  const Button = (props: { index: number }) => {
    const button = buttons[props.index];
    return (
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        accessibilityRole="button"
        accessibilityLabel={button.text}
        onPress={() => press(button.decision)}
      >
        <Text
          style={[
            styles.buttonText,
            props.index === 1 && styles.primaryText,
            button.style === 'cancel' && styles.cancelText,
            Typography.default(button.style === 'cancel' ? undefined : 'semiBold'),
          ]}
        >
          {button.text}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={[styles.title, Typography.default('semiBold')]}>{title}</Text>
        <Text style={[styles.message, Typography.default()]}>{message}</Text>
      </View>

      <View style={styles.buttonContainer}>
        <View style={styles.buttonRow}>
          <Button index={0} />
          <View style={styles.separatorVertical} />
          <Button index={2} />
        </View>
        <View style={styles.separatorHorizontal} />
        <Button index={1} />
      </View>
    </View>
  );
};

export async function showElevenLabsAgentReuseDialog(params: Readonly<{
  existingAgentId: string;
  existingAgentName: string;
}>): Promise<ElevenLabsAgentReuseDecision> {
  const existingAgentId = String(params.existingAgentId ?? '').trim();
  const existingAgentName = String(params.existingAgentName ?? '').trim();

  return await new Promise<ElevenLabsAgentReuseDecision>((resolve) => {
    let resolved = false;
    const resolveOnce = (decision: ElevenLabsAgentReuseDecision) => {
      if (resolved) return;
      resolved = true;
      resolve(decision);
    };

    type WrapperProps = Readonly<{ onClose: () => void; onRequestClose?: () => void }>;
    const Wrapper: React.FC<WrapperProps> = ({ onClose }) => (
      <ElevenLabsAgentReuseDialog
        title="Happier agent already exists"
        message={
          existingAgentId
            ? `We found an existing ElevenLabs agent (“${existingAgentName}”, id: ${existingAgentId}).\n\nDo you want to update it, or create a new one?`
            : `We found an existing ElevenLabs agent (“${existingAgentName}”).\n\nDo you want to update it, or create a new one?`
        }
        onResolve={resolveOnce}
        onClose={onClose}
      />
    );

    Modal.show({
      component: Wrapper,
      props: {
        onRequestClose: () => resolveOnce('cancel'),
      },
      closeOnBackdrop: true,
    });
  });
}
