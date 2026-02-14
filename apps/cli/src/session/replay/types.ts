export type HappierReplayDialogItem = Readonly<{
  role: 'User' | 'Assistant';
  createdAt: number;
  text: string;
}>;

